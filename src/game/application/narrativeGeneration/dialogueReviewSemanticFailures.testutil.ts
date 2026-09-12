import type { DialogueReviewSubject } from "./dialogueReviewChecks";
import type { InquiryAspect } from "@/game/domain/expressionTask";

/** Sanitized original DTO excerpts. Expectations are human audit judgments, not offline semantic proof.
 * Ambiguous cases are diagnostic only: pass/uncertain is not a confirmed complete contract. */
export type SemanticReviewSample = Readonly<{
  id: string; subjects: readonly DialogueReviewSubject[]; phase: "planning";
  expectedVerdicts: readonly ("pass" | "reject" | "uncertain")[];
  allowedDiagnostics: readonly { type: "extra_inquiry" | "intent_mismatch"; factId: string | null; aspect: InquiryAspect | null }[];
  diagnosticPrecision?: "unresolved_fact_address";
  unsupportedAspects: readonly InquiryAspect[]; ambiguity: string | null; assessment: string; source: string;
}>;
export const semanticReviewSamples: readonly SemanticReviewSample[] = [
  {
    "id": "npc_encounter",
    "subjects": [
      {
        "unitKey": "npc_encounter",
        "kind": "answer",
        "intent": "ask",
        "brief": "掌柜见沈孤鸿湿透带伤，招呼他进店避雨，说后厨还有热汤、楼上空房尚在；随后压低声音提一句，近来城外道上不太平，被劫的镖车不止一拨，问他是不是也撞上了。",
        "inquiries": [],
        "answers": [],
        "prerequisiteFactIds": [],
        "topicFactIds": [
          "fact_1"
        ],
        "facts": [
          {
            "id": "fact_1",
            "text": "近半月城外商道连发四起劫镖，被劫的都是小字号镖局。",
            "certainty": "known",
            "sources": []
          }
        ]
      }
    ],
    "phase": "planning",
    "expectedVerdicts": [
      "pass"
    ],
    "allowedDiagnostics": [],
    "unsupportedAspects": [
      "cause"
    ],
    "ambiguity": null,
    "assessment": "问他是不是也撞上了是在确认玩家遭遇，并没有询问劫镖原因。cause无文本支持。NPC自己向玩家发问是否还需另一种合同表示，不能从这条cause误报推断；也不能借未来玩家问题要求NPC回答。",
    "source": "tmp/staged-final-retest-20260912/diagnostic-corpus.json $[2].reviews[0].request.checks[0]; control-review.json $.wuxiaOpening.findings[0]"
  },
  {
    "id": "token_identity",
    "subjects": [
      {
        "unitKey": "token_identity",
        "candidateId": "token_identity",
        "kind": "option",
        "intent": "ask",
        "brief": "取出那枚青铜令牌，问掌柜是否认得此物、这信物外头有没有流出来过；再问城西一带近来可有寒山派的人走动，什么时候来的。",
        "inquiries": [
          {
            "factId": "fact_3",
            "aspects": [
              "identity",
              "source"
            ]
          },
          {
            "factId": "fact_0",
            "aspects": [
              "location",
              "time"
            ]
          }
        ],
        "answers": [],
        "prerequisiteFactIds": [],
        "topicFactIds": [
          "fact_3",
          "fact_0"
        ],
        "facts": [
          {
            "id": "fact_0",
            "text": "临江城近日有寒山派弟子出入，多在西城一带落脚。",
            "certainty": "known",
            "sources": []
          },
          {
            "id": "fact_3",
            "text": "青铜令牌是寒山派弟子随身信物，样式外传极少，外人难以仿造。",
            "certainty": "known",
            "sources": []
          }
        ]
      }
    ],
    "phase": "planning",
    "expectedVerdicts": [
      "pass"
    ],
    "allowedDiagnostics": [],
    "unsupportedAspects": [
      "reliability"
    ],
    "ambiguity": null,
    "assessment": "辨认令牌及是否外流对应identity/source；寒山派行踪和何时到达对应location/time，均已编码。没有问令牌真假可信度。审核请求明确禁止将认不认得、不熟悉、出处额外标成reliability；该条违反自身审核准则。",
    "source": "tmp/staged-final-retest-20260912/diagnostic-corpus.json $[2].reviews[0].request.checks[1]; control-review.json $.wuxiaOpening.findings[1]"
  },
  {
    "id": "investigation_occurrence",
    "subjects": [
      {
        "unitKey": "investigation_occurrence",
        "candidateId": "investigation_occurrence",
        "kind": "option",
        "intent": "challenge",
        "brief": "不信告示上流寇所为的说法，指出被劫的都是小字号镖局、悬赏至今无人落网；问掌柜这说法到底从哪来，衙门究竟有没有真去查过。",
        "inquiries": [
          {
            "factId": "fact_2",
            "aspects": [
              "source",
              "reliability"
            ]
          }
        ],
        "answers": [],
        "prerequisiteFactIds": [],
        "topicFactIds": [
          "fact_2",
          "fact_1"
        ],
        "facts": [
          {
            "id": "fact_1",
            "text": "近半月城外商道连发四起劫镖，被劫的都是小字号镖局。",
            "certainty": "known",
            "sources": []
          },
          {
            "id": "fact_2",
            "text": "衙门贴出告示，将劫案归为流寇所为，悬赏缉拿，至今无人落网。",
            "certainty": "known",
            "sources": []
          }
        ]
      }
    ],
    "phase": "planning",
    "expectedVerdicts": [
      "pass",
      "uncertain"
    ],
    "allowedDiagnostics": [],
    "unsupportedAspects": [
      "method"
    ],
    "ambiguity": "说法从哪来已有source；是否真正调查可解释为要求可信根据或确认调查事件，不能直接推出询问如何调查的method。若认为新增调查事件必须单列，应明确其事实及维度；此处不足以确认method是正确最小反例，亦不以此证明整个brief毫无合同缺口。",
    "assessment": "说法从哪来已有source；是否真正调查可解释为要求可信根据或确认调查事件，不能直接推出询问如何调查的method。若认为新增调查事件必须单列，应明确其事实及维度；此处不足以确认method是正确最小反例，亦不以此证明整个brief毫无合同缺口。",
    "source": "tmp/staged-final-retest-20260912/diagnostic-corpus.json $[2].reviews[0].request.checks[2]; control-review.json $.wuxiaOpening.findings[2]"
  },
  {
    "id": "signal_origin",
    "subjects": [
      {
        "unitKey": "signal_origin",
        "candidateId": "signal_origin",
        "kind": "option",
        "intent": "ask",
        "brief": "向回声追问：那封加密求救信号具体来自哪里，能不能确认它的来源，以及它现在是否仍然有效。",
        "inquiries": [
          {
            "factId": "fact_1",
            "aspects": [
              "source",
              "reliability"
            ]
          }
        ],
        "answers": [],
        "prerequisiteFactIds": [],
        "topicFactIds": [
          "fact_1",
          "fact_3"
        ],
        "facts": [
          {
            "id": "fact_1",
            "text": "唯一仍在传输的是来自失联母站的一封加密求救信号，其坐标指向母站。",
            "certainty": "known",
            "sources": []
          },
          {
            "id": "fact_3",
            "text": "这一航段上没有其他船只的应答记录，母站失联后周边保持静默。",
            "certainty": "known",
            "sources": []
          }
        ]
      }
    ],
    "phase": "planning",
    "expectedVerdicts": [
      "pass",
      "uncertain"
    ],
    "allowedDiagnostics": [],
    "unsupportedAspects": [
      "location"
    ],
    "ambiguity": "The address is protocol-valid, but 来自哪里 can mean the signal's source, already encoded. The brief never explicitly asks a separate present position or precise coordinates. Conversely, 具体来自哪里 can be read spatially, so a definite false-positive claim is also too strong.",
    "assessment": "The address is protocol-valid, but 来自哪里 can mean the signal's source, already encoded. The brief never explicitly asks a separate present position or precise coordinates. Conversely, 具体来自哪里 can be read spatially, so a definite false-positive claim is also too strong.",
    "source": "tmp/staged-final-retest-20260912/diagnostic-corpus.json $[0].reviews[0].request.checks[1]; failure-review.json $.science_fiction.reviews[1].locationAssessment"
  },
  {
    "id": "given_time_range",
    "subjects": [
      {
        "unitKey": "given_time_range",
        "candidateId": "given_time_range",
        "kind": "option",
        "intent": "challenge",
        "brief": "沈孤鸿不接受柳素娘把话说到这里就停，指出她说'被劫的不止一辆'，可见她早知情；他要她把这几夜住店的生面孔、城外被劫的三起案子说清楚。",
        "inquiries": [],
        "answers": [],
        "prerequisiteFactIds": [],
        "topicFactIds": [
          "fact_1",
          "fact_3"
        ],
        "facts": [
          {
            "id": "fact_1",
            "text": "近半月，落雁镇外的驿道接连有三起镖车被劫，劫者不取货，只翻车底夹层，动手极快。",
            "certainty": "known",
            "sources": []
          },
          {
            "id": "fact_3",
            "text": "归雁客栈是落雁镇夜里唯一还接客的客栈，掌柜柳素娘从不过问客人的来路。",
            "certainty": "known",
            "sources": []
          }
        ]
      }
    ],
    "phase": "planning",
    "expectedVerdicts": [
      "reject"
    ],
    "allowedDiagnostics": [],
    "diagnosticPrecision": "unresolved_fact_address",
    "unsupportedAspects": [
      "time"
    ],
    "ambiguity": null,
    "assessment": "补测reject及planning/r_probe_ambush定位正确，extra_inquiry类别合理；但fact_1/time不是可靠最小反例。这几夜是给定住宿范围，三起案子说清楚未具体追问时刻。明确缺失的信息至少为生面孔身份；不能把泛化案件细节自动确认为time。返回维度会引导错误合同修复，故不能算完整诊断正确。",
    "source": "tmp/staged-final-retest-20260912/control-review.json $.controls[id=real_wuxia_missing_1]; contrast-correction/preregistered-live.json $.samples[1].request.checks[0]"
  },
  {
    "id": "no_ship_response",
    "subjects": [
      {
        "unitKey": "no_ship_response",
        "candidateId": "no_ship_response",
        "kind": "option",
        "intent": "offer",
        "brief": "建议先不急着回应那封信号：请回声列出本船残存的补给与可用航路数据，并确认这一航段是否真的没有其他船只，再决定要不要朝母站坐标靠近。",
        "inquiries": [],
        "answers": [],
        "prerequisiteFactIds": [],
        "topicFactIds": [
          "fact_0",
          "fact_2",
          "fact_3"
        ],
        "facts": [
          {
            "id": "fact_0",
            "text": "货船脱离跃迁后，导航、通讯与推进读数同时失效，全船只剩一枚信号灯仍在闪动。",
            "certainty": "known",
            "sources": []
          },
          {
            "id": "fact_2",
            "text": "殖民星系依赖跃迁网络维系补给，边境站的物资按固定航次送达。",
            "certainty": "known",
            "sources": []
          },
          {
            "id": "fact_3",
            "text": "这一航段上没有其他船只的应答记录，母站失联后周边保持静默。",
            "certainty": "known",
            "sources": []
          }
        ]
      }
    ],
    "phase": "planning",
    "expectedVerdicts": [
      "reject"
    ],
    "allowedDiagnostics": [
      {
        "type": "extra_inquiry",
        "factId": "fact_3",
        "aspect": "reliability"
      },
      {
        "type": "intent_mismatch",
        "factId": null,
        "aspect": null
      }
    ],
    "unsupportedAspects": [],
    "ambiguity": null,
    "assessment": "The brief requests confirmation of whether there really are no other ships. No inquiry or prerequisite condition encodes it, and no response record is weaker than no ships. Therefore it is not merely a harmless action proposal or verification of an already registered prerequisite.",
    "source": "tmp/staged-final-retest-20260912/diagnostic-corpus.json $[0].reviews[0].request.checks[2]; failure-review.json $.science_fiction.reviews[1].reliabilityAssessment"
  }
];
