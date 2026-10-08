package devin

import (
	"encoding/binary"
	"math"

	"github.com/ngosangns/ns-bridge/go/internal/pbwire"
)

// The model-catalog and account-status messages behind the `models` and
// `usage` operations, transcribed from
// packages/devin-core/src/proto/devin-messages.ts (decoded fields only).

// encodeWithDisplays is Metadata plus the packed `supported_model_displays`
// (field 30, declared after `user_jwt`).
func (m Metadata) encodeWithDisplays(displays []int32) []byte {
	body := m.encode()
	if len(displays) == 0 {
		return body
	}
	var packed []byte
	for _, d := range displays {
		packed = binary.AppendUvarint(packed, uint64(int64(d)))
	}
	var w pbwire.Writer
	w.Message(30, packed)
	return append(body, w.Finish()...)
}

// encodeMetadataRequest is any `{ metadata = 1 }` request message.
func encodeMetadataRequest(metadata []byte) []byte {
	var w pbwire.Writer
	w.Message(1, metadata)
	return w.Finish()
}

func int32Of(f pbwire.Field) int32 { return int32(int64(f.Uint)) }

func float32Of(f pbwire.Field) float64 { return float64(math.Float32frombits(uint32(f.Uint))) }

type wantType map[int]int

// eachTyped is pbwire.Each with wire-type checks for the fields in want.
func eachTyped(data []byte, want wantType, fn func(pbwire.Field) error) error {
	return pbwire.Each(data, func(f pbwire.Field) error {
		if wt, ok := want[f.No]; ok {
			if err := pbwire.Expect(f, wt); err != nil {
				return err
			}
			return fn(f)
		}
		return nil
	})
}

const (
	tV = pbwire.Varint
	tB = pbwire.Bytes
	tF = pbwire.Fixed32
)

// ModelFeatures is exa.codeium_common_pb.ModelFeatures.
type ModelFeatures struct {
	SupportsImages, SupportsToolCalls, SupportsParallelToolCalls, SupportsThinking bool
}

func decodeModelFeatures(data []byte) (*ModelFeatures, error) {
	var m ModelFeatures
	err := eachTyped(data, wantType{11: tV, 12: tV, 21: tV, 15: tV}, func(f pbwire.Field) error {
		switch f.No {
		case 11:
			m.SupportsImages = f.Uint != 0
		case 12:
			m.SupportsToolCalls = f.Uint != 0
		case 21:
			m.SupportsParallelToolCalls = f.Uint != 0
		case 15:
			m.SupportsThinking = f.Uint != 0
		}
		return nil
	})
	return &m, err
}

// ModelInfo is exa.codeium_common_pb.ModelInfo.
type ModelInfo struct {
	MaxTokens       int32
	ModelFeatures   *ModelFeatures
	MaxOutputTokens int32
	HarnessUids     []string
	DisplayOption   int32
	IsModelRouter   bool
}

func decodeModelInfo(data []byte) (*ModelInfo, error) {
	var m ModelInfo
	err := eachTyped(data, wantType{4: tV, 6: tB, 13: tV, 20: tB, 22: tV, 25: tV}, func(f pbwire.Field) error {
		switch f.No {
		case 4:
			m.MaxTokens = int32Of(f)
		case 6:
			v, err := decodeModelFeatures(f.Data)
			if err != nil {
				return err
			}
			m.ModelFeatures = v
		case 13:
			m.MaxOutputTokens = int32Of(f)
		case 20:
			m.HarnessUids = append(m.HarnessUids, f.Str())
		case 22:
			m.DisplayOption = int32Of(f)
		case 25:
			m.IsModelRouter = f.Uint != 0
		}
		return nil
	})
	return &m, err
}

// ModelFamilyValue is exa.codeium_common_pb.ModelFamilyMetadataValue.
type ModelFamilyValue struct {
	Order int32
	Name  string
}

// ModelFamilyEntry is exa.codeium_common_pb.ModelFamilyMetadataEntry.
type ModelFamilyEntry struct {
	Key   string
	Value *ModelFamilyValue
}

// ModelFamilyMetadata is exa.codeium_common_pb.ModelFamilyMetadata.
type ModelFamilyMetadata struct {
	ModelFamilyLabel       string
	Entries                []ModelFamilyEntry
	IsDefaultModelInFamily bool
}

func decodeModelFamilyMetadata(data []byte) (*ModelFamilyMetadata, error) {
	var m ModelFamilyMetadata
	err := eachTyped(data, wantType{1: tB, 2: tB, 3: tV}, func(f pbwire.Field) error {
		switch f.No {
		case 1:
			m.ModelFamilyLabel = f.Str()
		case 2:
			var e ModelFamilyEntry
			err := eachTyped(f.Data, wantType{1: tB, 2: tB}, func(g pbwire.Field) error {
				switch g.No {
				case 1:
					e.Key = g.Str()
				case 2:
					var v ModelFamilyValue
					if err := eachTyped(g.Data, wantType{1: tV, 2: tB}, func(h pbwire.Field) error {
						if h.No == 1 {
							v.Order = int32Of(h)
						} else {
							v.Name = h.Str()
						}
						return nil
					}); err != nil {
						return err
					}
					e.Value = &v
				}
				return nil
			})
			if err != nil {
				return err
			}
			m.Entries = append(m.Entries, e)
		case 3:
			m.IsDefaultModelInFamily = f.Uint != 0
		}
		return nil
	})
	return &m, err
}

// ModelDimension is exa.codeium_common_pb.ModelDimension.
type ModelDimension struct {
	Label       string
	Value       float64
	Denominator string
	Kind        int32
}

const (
	dimensionKindCost      = 1
	dimensionKindCostFuzzy = 2
)

// ClientModelConfig is exa.codeium_common_pb.ClientModelConfig.
type ClientModelConfig struct {
	Label                  string
	ModelUID               string
	Disabled               bool
	SupportsImages         bool
	IsBeta                 bool
	IsRecommended          bool
	IsNew                  bool
	MaxTokens              int32
	ModelInfo              *ModelInfo
	Description            string
	ModelFamilyMetadata    *ModelFamilyMetadata
	IsDefaultModelInFamily bool
	ModelDimensions        []ModelDimension
}

func decodeClientModelConfig(data []byte) (ClientModelConfig, error) {
	var m ClientModelConfig
	want := wantType{1: tB, 22: tB, 4: tV, 5: tV, 9: tV, 11: tV, 15: tV, 18: tV, 23: tB, 27: tB, 30: tB, 31: tV, 32: tB}
	err := eachTyped(data, want, func(f pbwire.Field) error {
		switch f.No {
		case 1:
			m.Label = f.Str()
		case 22:
			m.ModelUID = f.Str()
		case 4:
			m.Disabled = f.Uint != 0
		case 5:
			m.SupportsImages = f.Uint != 0
		case 9:
			m.IsBeta = f.Uint != 0
		case 11:
			m.IsRecommended = f.Uint != 0
		case 15:
			m.IsNew = f.Uint != 0
		case 18:
			m.MaxTokens = int32Of(f)
		case 23:
			v, err := decodeModelInfo(f.Data)
			if err != nil {
				return err
			}
			m.ModelInfo = v
		case 27:
			m.Description = f.Str()
		case 30:
			v, err := decodeModelFamilyMetadata(f.Data)
			if err != nil {
				return err
			}
			m.ModelFamilyMetadata = v
		case 31:
			m.IsDefaultModelInFamily = f.Uint != 0
		case 32:
			var d ModelDimension
			if err := eachTyped(f.Data, wantType{1: tB, 2: tF, 3: tB, 6: tV}, func(g pbwire.Field) error {
				switch g.No {
				case 1:
					d.Label = g.Str()
				case 2:
					d.Value = float32Of(g)
				case 3:
					d.Denominator = g.Str()
				case 6:
					d.Kind = int32Of(g)
				}
				return nil
			}); err != nil {
				return err
			}
			m.ModelDimensions = append(m.ModelDimensions, d)
		}
		return nil
	})
	return m, err
}

// decodeGetCliModelConfigsResponse returns `client_model_configs`.
func decodeGetCliModelConfigsResponse(data []byte) ([]ClientModelConfig, error) {
	configs := []ClientModelConfig{}
	err := eachTyped(data, wantType{1: tB}, func(f pbwire.Field) error {
		c, err := decodeClientModelConfig(f.Data)
		if err != nil {
			return err
		}
		configs = append(configs, c)
		return nil
	})
	return configs, err
}

// Timestamp is google.protobuf.Timestamp.
type Timestamp struct {
	Seconds int64
	Nanos   int32
}

func decodeTimestamp(data []byte) (*Timestamp, error) {
	var t Timestamp
	err := eachTyped(data, wantType{1: tV, 2: tV}, func(f pbwire.Field) error {
		if f.No == 1 {
			t.Seconds = int64(f.Uint)
		} else {
			t.Nanos = int32Of(f)
		}
		return nil
	})
	return &t, err
}

// DevinPlanInfo is exa.codeium_common_pb.DevinPlanInfo.
type DevinPlanInfo struct {
	OrgID, AccountDisplayName string
}

// PlanInfo is exa.codeium_common_pb.PlanInfo (the fields usage reads).
type PlanInfo struct {
	TeamsTier                       int32
	PlanName                        string
	MonthlyPromptCredits            int32
	MonthlyFlowCredits              int32
	MonthlyFlexCreditPurchaseAmount int32
	DevinInfo                       *DevinPlanInfo
	BillingStrategy                 int32
	HideDailyQuota, HideWeeklyQuota bool
}

func decodePlanInfo(data []byte) (*PlanInfo, error) {
	var m PlanInfo
	err := eachTyped(data, wantType{1: tV, 2: tB, 12: tV, 13: tV, 14: tV, 33: tB, 35: tV, 36: tV, 37: tV}, func(f pbwire.Field) error {
		switch f.No {
		case 1:
			m.TeamsTier = int32Of(f)
		case 2:
			m.PlanName = f.Str()
		case 12:
			m.MonthlyPromptCredits = int32Of(f)
		case 13:
			m.MonthlyFlowCredits = int32Of(f)
		case 14:
			m.MonthlyFlexCreditPurchaseAmount = int32Of(f)
		case 33:
			var d DevinPlanInfo
			if err := eachTyped(f.Data, wantType{4: tB, 8: tB}, func(g pbwire.Field) error {
				if g.No == 4 {
					d.OrgID = g.Str()
				} else {
					d.AccountDisplayName = g.Str()
				}
				return nil
			}); err != nil {
				return err
			}
			m.DevinInfo = &d
		case 35:
			m.BillingStrategy = int32Of(f)
		case 36:
			m.HideDailyQuota = f.Uint != 0
		case 37:
			m.HideWeeklyQuota = f.Uint != 0
		}
		return nil
	})
	return &m, err
}

// PlanStatus is exa.codeium_common_pb.PlanStatus (the fields usage reads).
type PlanStatus struct {
	PlanInfo                                                            *PlanInfo
	PlanEnd                                                             *Timestamp
	AvailablePromptCredits, AvailableFlowCredits, AvailableFlexCredits  int32
	UsedPromptCredits, UsedFlowCredits, UsedFlexCredits                 int32
	DailyQuotaRemainingPercent, WeeklyQuotaRemainingPercent             int32
	OverageBalanceMicros, DailyQuotaResetAtUnix, WeeklyQuotaResetAtUnix int64
}

func decodePlanStatus(data []byte) (*PlanStatus, error) {
	var m PlanStatus
	want := wantType{1: tB, 3: tB, 4: tV, 5: tV, 6: tV, 7: tV, 8: tV, 9: tV, 14: tV, 15: tV, 16: tV, 17: tV, 18: tV}
	err := eachTyped(data, want, func(f pbwire.Field) error {
		switch f.No {
		case 1:
			v, err := decodePlanInfo(f.Data)
			if err != nil {
				return err
			}
			m.PlanInfo = v
		case 3:
			v, err := decodeTimestamp(f.Data)
			if err != nil {
				return err
			}
			m.PlanEnd = v
		case 8:
			m.AvailablePromptCredits = int32Of(f)
		case 9:
			m.AvailableFlowCredits = int32Of(f)
		case 4:
			m.AvailableFlexCredits = int32Of(f)
		case 7:
			m.UsedFlexCredits = int32Of(f)
		case 5:
			m.UsedFlowCredits = int32Of(f)
		case 6:
			m.UsedPromptCredits = int32Of(f)
		case 14:
			m.DailyQuotaRemainingPercent = int32Of(f)
		case 15:
			m.WeeklyQuotaRemainingPercent = int32Of(f)
		case 16:
			m.OverageBalanceMicros = int64(f.Uint)
		case 17:
			m.DailyQuotaResetAtUnix = int64(f.Uint)
		case 18:
			m.WeeklyQuotaResetAtUnix = int64(f.Uint)
		}
		return nil
	})
	return &m, err
}

// UserStatus is exa.codeium_common_pb.UserStatus (the fields usage reads).
type UserStatus struct {
	TeamID, Email, UserID string
	TeamsTier             int32
	PlanStatus            *PlanStatus
}

// GetUserStatusResponse is exa.seat_management_pb.GetUserStatusResponse.
type GetUserStatusResponse struct {
	UserStatus *UserStatus
	PlanInfo   *PlanInfo
}

func decodeGetUserStatusResponse(data []byte) (GetUserStatusResponse, error) {
	var m GetUserStatusResponse
	err := eachTyped(data, wantType{1: tB, 2: tB}, func(f pbwire.Field) error {
		if f.No == 2 {
			v, err := decodePlanInfo(f.Data)
			if err != nil {
				return err
			}
			m.PlanInfo = v
			return nil
		}
		var u UserStatus
		if err := eachTyped(f.Data, wantType{5: tB, 7: tB, 10: tV, 13: tB, 36: tB}, func(g pbwire.Field) error {
			switch g.No {
			case 5:
				u.TeamID = g.Str()
			case 7:
				u.Email = g.Str()
			case 10:
				u.TeamsTier = int32Of(g)
			case 13:
				v, err := decodePlanStatus(g.Data)
				if err != nil {
					return err
				}
				u.PlanStatus = v
			case 36:
				u.UserID = g.Str()
			}
			return nil
		}); err != nil {
			return err
		}
		m.UserStatus = &u
		return nil
	})
	return m, err
}
