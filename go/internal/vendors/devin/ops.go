package devin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
	"github.com/ngosangns/ns-bridge/go/internal/jsstr"
	"github.com/ngosangns/ns-bridge/go/internal/sidecar"
)

// Call implements sidecar.Caller: the one-shot `models` (GetCliModelConfigs)
// and `usage` (GetUserStatus) operations. Both are advisory and fail soft,
// exactly like fetchDevinModels / fetchDevinUsage: a failed request is a null
// result, not an error.
func (Vendor) Call(ctx context.Context, op string, raw json.RawMessage) (any, error) {
	switch op {
	case "models":
		var req ModelsRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, bridge.Errorf(bridge.KindInvalidRequest, "devin models request: %v", err)
		}
		timeout := 5_000.0
		if req.TimeoutMs != nil {
			timeout = *req.TimeoutMs
		}
		cctx, cancel := context.WithTimeout(ctx, time.Duration(math.Max(timeout, 0)*float64(time.Millisecond)))
		defer cancel()
		models := fetchModels(cctx, req)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if models == nil {
			return nil, nil
		}
		out := make([]jsjson.Value, len(models))
		for i, m := range models {
			out[i] = m.toJSON()
		}
		return out, nil
	case "usage":
		var req UsageRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, bridge.Errorf(bridge.KindInvalidRequest, "devin usage request: %v", err)
		}
		result := fetchUsage(ctx, req)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return result, nil
	default:
		return nil, sidecar.ErrUnknownOp
	}
}

// UsageRequest is the `usage` operation's input (DevinUsageFetchOptions).
type UsageRequest struct {
	APIKey  *string `json:"apiKey"`
	BaseURL *string `json:"baseUrl"`
}

// fetchUsage is fetchDevinUsage. The result is `{report, raw}`: the report
// without its `raw` member, plus the response body (base64) the TypeScript
// facade decodes into `raw` with its own codec. Nil on any failure.
func fetchUsage(ctx context.Context, req UsageRequest) any {
	token := ""
	if req.APIKey != nil {
		token = jsstr.Trim(*req.APIKey)
	}
	if token == "" {
		return nil
	}
	base := DefaultBaseURL
	if req.BaseURL != nil {
		base = *req.BaseURL
	}
	base = strings.TrimRight(base, "/")
	var body []byte
	keep := func(payload []byte) ([]byte, error) {
		_, err := decodeGetUserStatusResponse(payload)
		return payload, err
	}
	request := func(m Metadata) ([]byte, bool, error) {
		return postUnary(ctx, base, userStatusPath, encodeMetadataRequest(m.encode()), "user status", keep)
	}
	payload, ok, err := request(cliMetadata(token, ""))
	if err != nil {
		var apiErr *APIError
		if !errors.As(err, &apiErr) || apiErr.Status != 401 || strings.HasPrefix(token, SessionTokenPrefix) {
			return nil
		}
		payload, ok, err = request(wireMetadata(token, ""))
		if err != nil {
			return nil
		}
	}
	if !ok {
		return nil
	}
	body = payload
	decoded, err := decodeGetUserStatusResponse(body)
	if err != nil {
		return nil
	}
	report := buildUsageReport(decoded)
	if report == nil {
		return nil
	}
	out := jsjson.NewObject()
	out.Set("report", report)
	out.Set("raw", base64.StdEncoding.EncodeToString(body))
	return out
}

var teamsTierNames = map[int32]string{
	1: "TEAMS", 2: "PRO", 9: "TRIAL", 3: "ENTERPRISE_SAAS", 4: "HYBRID", 5: "ENTERPRISE_SELF_HOSTED",
	10: "ENTERPRISE_SELF_SERVE", 12: "DEVIN_ENTERPRISE", 14: "DEVIN_TEAMS", 15: "DEVIN_TEAMS_V2",
	16: "DEVIN_PRO", 17: "DEVIN_MAX", 18: "MAX", 19: "DEVIN_FREE", 20: "DEVIN_TRIAL", 6: "WAITLIST_PRO",
	7: "TEAMS_ULTIMATE", 8: "PRO_ULTIMATE", 11: "ENTERPRISE_SAAS_POOLED",
}

// tierLabel is devinTierLabel: `DEVIN_PRO` → `Devin Pro`.
func tierLabel(tier int32) string {
	name, ok := teamsTierNames[tier]
	if !ok {
		return ""
	}
	words := strings.Split(strings.ToLower(name), "_")
	for i, w := range words {
		if w != "" {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}

const billingStrategyQuota = 2

func creditLimit(id, label string, limit, used, available int32, resetsAt float64) *jsjson.Object {
	u := math.Max(0, float64(used))
	remaining := math.Max(0, float64(available))
	if limit <= 0 && u == 0 && remaining == 0 {
		return nil
	}
	o := jsjson.NewObject()
	o.Set("id", "devin:credits:"+id)
	o.Set("label", label)
	o.Set("window", "monthly")
	o.Set("used", u)
	o.Set("remaining", remaining)
	if limit > 0 {
		o.Set("limit", float64(limit))
		o.Set("usedFraction", u/float64(limit))
	}
	o.Set("unit", "credits")
	if resetsAt > 0 {
		o.Set("resetsAt", resetsAt)
	}
	return o
}

func quotaLimit(id, label string, remainingPercent int32, resetAtUnix int64) *jsjson.Object {
	remaining := math.Max(0, math.Min(100, float64(remainingPercent)))
	used := 100 - remaining
	o := jsjson.NewObject()
	o.Set("id", "devin:quota:"+id)
	o.Set("label", label)
	o.Set("window", id)
	o.Set("used", used)
	o.Set("limit", 100.0)
	o.Set("remaining", remaining)
	o.Set("usedFraction", used/100)
	o.Set("unit", "percent")
	if resetAt := float64(resetAtUnix); resetAt > 0 {
		o.Set("resetsAt", resetAt*1000)
	}
	return o
}

// buildUsageReport is buildDevinUsageReport, minus `raw`.
func buildUsageReport(r GetUserStatusResponse) *jsjson.Object {
	us := r.UserStatus
	if us == nil {
		return nil
	}
	ps := us.PlanStatus
	plan := r.PlanInfo
	if plan == nil && ps != nil {
		plan = ps.PlanInfo
	}
	email := jsstr.Trim(us.Email)
	accountID := jsstr.Trim(us.UserID)
	orgID, orgName, planName := "", "", ""
	if plan != nil && plan.DevinInfo != nil {
		orgID = jsstr.Trim(plan.DevinInfo.OrgID)
		orgName = jsstr.Trim(plan.DevinInfo.AccountDisplayName)
	}
	if orgID == "" {
		orgID = jsstr.Trim(us.TeamID)
	}
	if plan != nil {
		planName = jsstr.Trim(plan.PlanName)
	}
	if planName == "" {
		tier := us.TeamsTier
		if plan != nil {
			tier = plan.TeamsTier
		}
		planName = tierLabel(tier)
	}
	planEnd, hasPlanEnd := 0.0, false
	if ps != nil && ps.PlanEnd != nil {
		planEnd = float64(ps.PlanEnd.Seconds)*1_000 + float64(ps.PlanEnd.Nanos)/1_000_000
		hasPlanEnd = true
	}

	limits := []jsjson.Value{}
	if ps != nil {
		resetsAt := 0.0
		if hasPlanEnd && planEnd > 0 {
			resetsAt = planEnd
		}
		var promptGrant, flowGrant, flexGrant int32
		if plan != nil {
			promptGrant, flowGrant, flexGrant = plan.MonthlyPromptCredits, plan.MonthlyFlowCredits, plan.MonthlyFlexCreditPurchaseAmount
		}
		for _, l := range []*jsjson.Object{
			creditLimit("prompt", "Prompt Credits", promptGrant, ps.UsedPromptCredits, ps.AvailablePromptCredits, resetsAt),
			creditLimit("flow", "Flow Credits", flowGrant, ps.UsedFlowCredits, ps.AvailableFlowCredits, resetsAt),
			creditLimit("flex", "Flex Credits", flexGrant, ps.UsedFlexCredits, ps.AvailableFlexCredits, resetsAt),
		} {
			if l != nil {
				limits = append(limits, l)
			}
		}
		applies := func(resetAt int64, hidden bool) bool {
			if hidden {
				return false
			}
			if resetAt > 0 {
				return true
			}
			return plan != nil && plan.BillingStrategy == billingStrategyQuota
		}
		if applies(ps.DailyQuotaResetAtUnix, plan != nil && plan.HideDailyQuota) {
			limits = append(limits, quotaLimit("daily", "Daily Quota", ps.DailyQuotaRemainingPercent, ps.DailyQuotaResetAtUnix))
		}
		if applies(ps.WeeklyQuotaResetAtUnix, plan != nil && plan.HideWeeklyQuota) {
			limits = append(limits, quotaLimit("weekly", "Weekly Quota", ps.WeeklyQuotaRemainingPercent, ps.WeeklyQuotaResetAtUnix))
		}
	}

	overage := 0.0
	if ps != nil {
		overage = float64(ps.OverageBalanceMicros) / 1_000_000
	}
	o := jsjson.NewObject()
	for _, kv := range [][2]string{{"email", email}, {"accountId", accountID}, {"orgId", orgID}, {"orgName", orgName}, {"planName", planName}} {
		if kv[1] != "" {
			o.Set(kv[0], kv[1])
		}
	}
	if hasPlanEnd && planEnd > 0 {
		o.Set("planEnd", planEnd)
	}
	if overage != 0 {
		o.Set("overageBalanceUsd", overage)
	}
	o.Set("limits", limits)
	return o
}
