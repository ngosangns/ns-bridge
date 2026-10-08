package devin

import (
	"context"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
	"github.com/ngosangns/ns-bridge/go/internal/jsstr"
)

// Port of packages/devin-core/src/discovery.ts: GetCliModelConfigs and its
// normalization onto DevinModelSpec records.

const (
	defaultContextWindow = 200_000
	defaultMaxTokens     = 64_000

	displayUnspecified     = 0
	displayModelRouter     = 3
	displayQuickReview     = 4
	displayInternalDefault = 6
	displayUnclassified    = 7
	displayNormal          = 8
)

var supportedModelDisplays = []int32{displayModelRouter, displayQuickReview, displayInternalDefault, displayUnclassified, displayNormal}

var internalModelDisplays = map[int32]bool{displayQuickReview: true, displayInternalDefault: true}

var (
	reasoningLabel   = regexp.MustCompile(`(?i)think|thinking|minimal|high|medium|low|xhigh|max|reasoning`)
	noReasoningLabel = regexp.MustCompile(`(?i)\bno thinking\b`)
	costDenominator  = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*([kmb])?`)
	nonAlnumRun      = regexp.MustCompile(`[^a-z0-9]+`)
	edgeDashes       = regexp.MustCompile(`^-+|-+$`)
)

var seedModelUIDs = map[string]bool{"swe-1-6": true, "swe-1-6-fast": true}

var imageBlindUIDs = map[string]bool{"swe-1-6": true, "swe-1-6-fast": true}

// legacyDiscoveryMetadata is the Windsurf editor identity legacy seats need.
func legacyDiscoveryMetadata(apiKey string) Metadata {
	return Metadata{
		APIKey:           apiKey,
		IdeName:          "windsurf",
		IdeVersion:       "3.2.23",
		ExtensionName:    "windsurf",
		ExtensionVersion: "1.48.2",
		Locale:           "en",
	}
}

var effortOrder = []string{"minimal", "low", "medium", "high", "xhigh", "max"}

var effortByName = map[string]string{
	"none": "off", "nothinking": "off", "minimal": "minimal", "low": "low",
	"medium": "medium", "high": "high", "xhigh": "xhigh", "max": "max",
}

// modelCost mirrors DevinCost.
type modelCost struct{ Input, Output, CacheRead, CacheWrite float64 }

// modelSpec mirrors DevinModelSpec; optional fields are pointers / nil slices.
type modelSpec struct {
	ID                        string
	Name                      string
	RequestModelID            *string
	Reasoning                 bool
	Efforts                   []string // nil = absent
	EffortMap                 [][2]string
	Input                     []string
	Cost                      modelCost
	ContextWindow             float64
	MaxTokens                 float64
	IsModelRouter             bool
	SupportsTools             bool
	SupportsParallelToolCalls bool
	BaseURL                   string
	Description               string
	IsNew, IsBeta             bool
	IsRecommended             bool
	DefaultEffort             string
}

func (s *modelSpec) toJSON() *jsjson.Object {
	o := jsjson.NewObject()
	o.Set("id", s.ID)
	o.Set("name", s.Name)
	if s.RequestModelID != nil {
		o.Set("requestModelId", *s.RequestModelID)
	}
	o.Set("reasoning", s.Reasoning)
	if s.Efforts != nil {
		efforts := make([]jsjson.Value, len(s.Efforts))
		for i, e := range s.Efforts {
			efforts[i] = e
		}
		o.Set("efforts", efforts)
		m := jsjson.NewObject()
		for _, kv := range s.EffortMap {
			m.Set(kv[0], kv[1])
		}
		o.Set("effortMap", m)
	}
	input := make([]jsjson.Value, len(s.Input))
	for i, v := range s.Input {
		input[i] = v
	}
	o.Set("input", input)
	cost := jsjson.NewObject()
	cost.Set("input", s.Cost.Input)
	cost.Set("output", s.Cost.Output)
	cost.Set("cacheRead", s.Cost.CacheRead)
	cost.Set("cacheWrite", s.Cost.CacheWrite)
	o.Set("cost", cost)
	o.Set("contextWindow", s.ContextWindow)
	o.Set("maxTokens", s.MaxTokens)
	o.Set("supportsTools", s.SupportsTools)
	o.Set("baseUrl", s.BaseURL)
	if s.IsModelRouter {
		o.Set("isModelRouter", true)
	}
	if s.SupportsParallelToolCalls {
		o.Set("supportsParallelToolCalls", true)
	}
	if s.Description != "" {
		o.Set("description", s.Description)
	}
	if s.IsNew {
		o.Set("isNew", true)
	}
	if s.IsBeta {
		o.Set("isBeta", true)
	}
	if s.IsRecommended {
		o.Set("isRecommended", true)
	}
	if s.DefaultEffort != "" {
		o.Set("defaultEffort", s.DefaultEffort)
	}
	return o
}

func supportsThinking(c *ClientModelConfig) bool {
	if c.ModelInfo != nil && c.ModelInfo.ModelFeatures != nil {
		return c.ModelInfo.ModelFeatures.SupportsThinking
	}
	if noReasoningLabel.MatchString(c.Label) {
		return false
	}
	return reasoningLabel.MatchString(c.Label)
}

func costDenominatorTokens(denominator string) float64 {
	m := costDenominator.FindStringSubmatch(denominator)
	if m == nil {
		return 1_000_000
	}
	scale := 1.0
	switch strings.ToLower(m[2]) {
	case "k":
		scale = 1_000
	case "m":
		scale = 1_000_000
	case "b":
		scale = 1_000_000_000
	}
	n, _ := strconv.ParseFloat(m[1], 64)
	if tokens := n * scale; tokens > 0 {
		return tokens
	}
	return 1_000_000
}

// jsRound is Math.round.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

func devinModelCost(c *ClientModelConfig) modelCost {
	var cost modelCost
	for _, d := range c.ModelDimensions {
		label := strings.ToLower(jsstr.Trim(d.Label))
		if label == "sidekick" {
			break
		}
		if d.Kind != dimensionKindCost && d.Kind != dimensionKindCostFuzzy {
			continue
		}
		perMillion := jsRound(((d.Value*1_000_000)/costDenominatorTokens(d.Denominator))*1e6) / 1e6
		switch label {
		case "input":
			cost.Input = perMillion
		case "cached input":
			cost.CacheRead = perMillion
		case "output":
			cost.Output = perMillion
		}
	}
	return cost
}

type familyLane struct {
	id, name      string
	members       []string
	defaultMember *string
	routing       map[string]string
}

type laneSet struct {
	order []*familyLane
	byID  map[string]*familyLane
}

func collectFamilyLane(lanes *laneSet, c *ClientModelConfig, uid string) {
	md := c.ModelFamilyMetadata
	if md == nil {
		return
	}
	label := jsstr.Trim(md.ModelFamilyLabel)
	if label == "" {
		return
	}
	effort := ""
	var thinking *bool
	fast, oneM := false, false
	for _, entry := range md.Entries {
		if entry.Value == nil {
			continue
		}
		key := jsstr.Trim(nonAlnumRun.ReplaceAllString(strings.ToLower(entry.Key), " "))
		switch {
		case key == "fast mode":
			fast = entry.Value.Order == 1
			continue
		case key == "thinking":
			t := entry.Value.Order == 1
			thinking = &t
			continue
		case key == "1m context":
			oneM = entry.Value.Order == 1
			continue
		}
		if key == "effort" || key == "reasoning effort" {
			effort = effortByName[nonAlnumRun.ReplaceAllString(strings.ToLower(entry.Value.Name), "")]
		}
	}
	if thinking != nil && !*thinking {
		effort = "off"
	}
	baseID := edgeDashes.ReplaceAllString(nonAlnumRun.ReplaceAllString(strings.ToLower(label), "-"), "")
	if baseID == "" {
		return
	}
	laneID, name := baseID, label
	if oneM {
		laneID += "-1m"
		name += " 1M"
	}
	if fast {
		laneID += "-fast"
		name += " Fast"
	}
	lane := lanes.byID[laneID]
	if lane == nil {
		lane = &familyLane{id: laneID, name: name, routing: map[string]string{}}
		lanes.byID[laneID] = lane
		lanes.order = append(lanes.order, lane)
	}
	lane.members = append(lane.members, uid)
	if lane.defaultMember == nil && (c.IsDefaultModelInFamily || md.IsDefaultModelInFamily) {
		u := uid
		lane.defaultMember = &u
	}
	if effort != "" {
		if _, taken := lane.routing[effort]; !taken {
			lane.routing[effort] = uid
		}
	}
}

func devinModelSpec(c *ClientModelConfig, uid, baseURL string, isAssignModelRouter bool) *modelSpec {
	var features *ModelFeatures
	if c.ModelInfo != nil {
		features = c.ModelInfo.ModelFeatures
	}
	images := c.SupportsImages
	if features != nil {
		images = features.SupportsImages
	}
	input := []string{"text"}
	if images && !imageBlindUIDs[uid] {
		input = []string{"text", "image"}
	}
	var maxOut int32
	if c.ModelInfo != nil {
		maxOut = c.ModelInfo.MaxOutputTokens
	}
	name := jsstr.Trim(c.Label)
	if name == "" {
		name = uid
	}
	s := &modelSpec{
		ID:            uid,
		Name:          name,
		Reasoning:     supportsThinking(c),
		Input:         input,
		SupportsTools: features == nil || features.SupportsToolCalls,
		Cost:          devinModelCost(c),
		ContextWindow: defaultContextWindow,
		MaxTokens:     defaultMaxTokens,
		BaseURL:       baseURL,
	}
	if c.MaxTokens > 0 {
		s.ContextWindow = float64(c.MaxTokens)
	}
	if maxOut > 0 {
		s.MaxTokens = float64(maxOut)
	}
	s.IsModelRouter = isAssignModelRouter
	s.SupportsParallelToolCalls = features != nil && features.SupportsParallelToolCalls
	s.Description = jsstr.Trim(c.Description)
	s.IsNew, s.IsBeta, s.IsRecommended = c.IsNew, c.IsBeta, c.IsRecommended
	return s
}

func collapseLanes(specs []*modelSpec, lanes *laneSet) []*modelSpec {
	byUID := map[string]*modelSpec{}
	for _, s := range specs {
		if _, ok := byUID[s.ID]; !ok {
			byUID[s.ID] = s
		}
	}
	consumed := map[string]bool{}
	laneIDs := map[string]bool{}
	out := append([]*modelSpec(nil), specs...)
	for _, lane := range lanes.order {
		var efforts []string
		for _, e := range effortOrder {
			if _, ok := lane.routing[e]; ok {
				efforts = append(efforts, e)
			}
		}
		if len(efforts) == 0 {
			continue
		}
		first := ""
		if len(lane.members) > 0 {
			first = lane.members[0]
		}
		defaultMember := first
		if lane.defaultMember != nil {
			defaultMember = *lane.defaultMember
		}
		template := byUID[defaultMember]
		if template == nil {
			template = byUID[first]
		}
		if template == nil {
			continue
		}
		effortMap := make([][2]string, 0, len(efforts))
		routed := map[string]bool{}
		for _, e := range efforts {
			effortMap = append(effortMap, [2]string{e, lane.routing[e]})
			routed[lane.routing[e]] = true
		}
		defaultEffort := ""
		for _, e := range efforts {
			if lane.routing[e] == defaultMember {
				defaultEffort = e
				break
			}
		}
		spec := *template
		spec.ID = lane.id
		spec.Name = lane.name
		dm := defaultMember
		spec.RequestModelID = &dm
		spec.Reasoning = true
		spec.Efforts = efforts
		spec.EffortMap = effortMap
		if defaultEffort != "" {
			spec.DefaultEffort = defaultEffort
		}
		out = append(out, &spec)
		for _, uid := range lane.members {
			if routed[uid] {
				consumed[uid] = true
			}
		}
		laneIDs[lane.id] = true
	}
	kept := out[:0]
	for _, s := range out {
		if consumed[s.ID] || (laneIDs[s.ID] && s.Efforts == nil) {
			continue
		}
		kept = append(kept, s)
	}
	return kept
}

// fusionLeadUID is devinFusionLeadUid: ok=false for non-pairings, lead=""
// (with ok) for a pairing whose lead is not live.
func fusionLeadUID(uid string, live map[string]*ClientModelConfig) (lead string, pairing bool) {
	if !strings.HasPrefix(uid, "fusion-") {
		return "", false
	}
	cut := strings.Index(uid, "-sidekick-")
	if cut <= len("fusion-") {
		return "", false
	}
	l := uid[len("fusion-"):cut]
	if _, ok := live[l]; ok {
		return l, true
	}
	if base, ok := strings.CutSuffix(l, "-fast"); ok {
		if _, ok := live[base+"-priority"]; ok {
			return base + "-priority", true
		}
		if _, ok := live[base]; ok {
			return base, true
		}
	}
	return "", true
}

func routeFusionLead(spec, lead *modelSpec) {
	id := lead.ID
	spec.RequestModelID = &id
	spec.Reasoning = lead.Reasoning
	spec.Input = lead.Input
	spec.SupportsTools = lead.SupportsTools
	spec.Cost = lead.Cost
	spec.ContextWindow = lead.ContextWindow
	spec.MaxTokens = lead.MaxTokens
	spec.SupportsParallelToolCalls = lead.SupportsParallelToolCalls
}

var collator = collate.New(language.Und)

// normalizeModels is normalizeDevinModels; baseURL is the override as given.
func normalizeModels(configs []ClientModelConfig, baseURLOverride *string) []*modelSpec {
	baseURL := DefaultBaseURL
	if baseURLOverride != nil {
		baseURL = *baseURLOverride
	}
	var specs []*modelSpec
	seen := map[string]bool{}
	lanes := &laneSet{byID: map[string]*familyLane{}}
	live := map[string]*ClientModelConfig{}
	for i := range configs {
		c := &configs[i]
		uid := jsstr.Trim(c.ModelUID)
		if _, dup := live[uid]; !c.Disabled && uid != "" && !dup {
			live[uid] = c
		}
	}
	for i := range configs {
		c := &configs[i]
		if c.Disabled {
			continue
		}
		display := int32(displayUnspecified)
		if c.ModelInfo != nil {
			display = c.ModelInfo.DisplayOption
		}
		if internalModelDisplays[display] {
			continue
		}
		uid := jsstr.Trim(c.ModelUID)
		if uid == "" || seen[uid] {
			continue
		}
		seen[uid] = true
		isRouter := display == displayModelRouter || (c.ModelInfo != nil && c.ModelInfo.IsModelRouter)
		harnesses := 0
		if c.ModelInfo != nil {
			harnesses = len(c.ModelInfo.HarnessUids)
		}
		lead, pairing := fusionLeadUID(uid, live)
		if pairing && lead == "" {
			continue
		}
		spec := devinModelSpec(c, uid, baseURL, isRouter && harnesses == 0)
		if pairing {
			if leadConfig := live[lead]; leadConfig != nil {
				routeFusionLead(spec, devinModelSpec(leadConfig, lead, baseURL, false))
			}
		}
		specs = append(specs, spec)
		if !isRouter {
			collectFamilyLane(lanes, c, uid)
		}
	}
	out := collapseLanes(specs, lanes)
	sort.SliceStable(out, func(i, j int) bool { return collator.CompareString(out[i].ID, out[j].ID) < 0 })
	return out
}

func allSeed(specs []*modelSpec) bool {
	for _, s := range specs {
		if !seedModelUIDs[s.ID] {
			return false
		}
	}
	return true
}

// ModelsRequest is the `models` operation's input (DevinModelDiscoveryOptions).
type ModelsRequest struct {
	APIKey    *string  `json:"apiKey"`
	BaseURL   *string  `json:"baseUrl"`
	TimeoutMs *float64 `json:"timeoutMs"`
}

// fetchModels is fetchDevinModels: nil on failure or an empty catalog.
func fetchModels(ctx context.Context, req ModelsRequest) []*modelSpec {
	base := DefaultBaseURL
	if req.BaseURL != nil {
		base = *req.BaseURL
	}
	base = strings.TrimRight(base, "/")
	apiKey := ""
	if req.APIKey != nil {
		apiKey = *req.APIKey
	}
	fetchCatalog := func(metadata []byte) []*modelSpec {
		configs, ok, err := postUnary(ctx, base, cliModelsPath, encodeMetadataRequest(metadata), "model configs", decodeGetCliModelConfigsResponse)
		if err != nil || !ok {
			return nil
		}
		out := normalizeModels(configs, req.BaseURL)
		if out == nil {
			out = []*modelSpec{}
		}
		return out
	}
	native := fetchCatalog(discoveryMetadata(apiKey).encodeWithDisplays(supportedModelDisplays))
	if native != nil && len(native) > 0 && !allSeed(native) {
		return native
	}
	legacy := fetchCatalog(legacyDiscoveryMetadata(apiKey).encode())
	models := native
	if legacy != nil && (native == nil || len(legacy) > len(native)) {
		models = legacy
	}
	if len(models) == 0 {
		return nil
	}
	return models
}
