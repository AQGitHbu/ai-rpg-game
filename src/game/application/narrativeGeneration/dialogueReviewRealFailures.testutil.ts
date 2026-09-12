import type { DialogueReviewSubject } from "./dialogueReviewChecks";
// Sanitized excerpts from tmp/staged-retest-20260912; exact displayed text and model outputs.
// unknown combines branch0 reply with branch1 future option solely to test cross-check isolation.
// branch1 original DTO omitted own NPC intent; null records that absence, not a guessed intent.
export const realReviewSubjects = {
  "unknown": [
    {
      "unitKey": "c1",
      "kind": "answer",
      "intent": "admit_unknown",
      "brief": "认证码指向哪一方、为什么用这种方式发，我都不知道。我只读出它反复出现，认证格式认不出来源。",
      "inquiries": [
        {
          "factId": "fact_3",
          "aspects": [
            "source",
            "purpose"
          ]
        }
      ],
      "answers": [
        {
          "factId": "fact_3",
          "aspect": "source",
          "outcome": "unknown",
          "answerFactIds": []
        },
        {
          "factId": "fact_3",
          "aspect": "purpose",
          "outcome": "unknown",
          "answerFactIds": []
        }
      ],
      "prerequisiteFactIds": [],
      "topicFactIds": [
        "fact_3"
      ],
      "facts": [
        {
          "id": "fact_3",
          "text": "那段求救带有一组重复的认证码和一段压缩坐标，认证格式读不出来源。",
          "certainty": "known",
          "sources": []
        }
      ],
      "text": "认证码指向哪一方，我不知道。\n为什么用这种方式发出来，我也不知道。\n我只读出它反复出现，认证格式认不出来源。",
      "selected": {
        "label": "那段求救里的认证码和压缩坐标，认证格式读不出来源——这组码指向哪一方？为什么用这种方式发出来？",
        "historicalChoice": true,
        "contract": {
          "intent": "ask",
          "inquiries": [
            {
              "factId": "fact_3",
              "aspects": [
                "source",
                "purpose"
              ]
            }
          ],
          "brief": "向薇拉询问那封加密求救里的认证码内容，问这段认证指向哪一方、为什么用这种方式发出。\n正文必须明确包含：[fact_3，known] 那段求救带有一组重复的认证码和一段压缩坐标，认证格式读不出来源。。\n必须针对事实 fact_3 具体询问：消息来源、目的。这些是待问的维度，未知答案不能当作已知事实；每个维度都须保留，不能替换成笼统的“怎么解释”。\n完整保留以上本轮内容的对象、回答、未知范围、态度、协助方式与条件；只调整措辞，不把相关话题背景补进内容稿，不增加线索、任务、路线或行动结果。",
          "prerequisiteFactIds": []
        }
      }
    },
    {
      "unitKey": "choices_current",
      "candidateId": "current_scene_choice_2",
      "kind": "option",
      "intent": "ask",
      "brief": "询问薇拉：母站那封加密求救的重复周期和信号强度是否稳定，能不能据此判断它仍是有人在主动发送，还是自动信标在循环。",
      "inquiries": [
        {
          "factId": "fact_0",
          "aspects": [
            "time",
            "reliability"
          ]
        }
      ],
      "answers": [],
      "prerequisiteFactIds": [],
      "topicFactIds": [
        "fact_0"
      ],
      "facts": [
        {
          "id": "fact_0",
          "text": "『长夜号』脱离跃迁后仪表全灭，唯一仍有响应的是来自失联母站的加密求救信号，正在重复发送。",
          "certainty": "known",
          "sources": [
            {
              "kind": "committed",
              "eventId": "init:gen_44f203d6-946d-4df0-b56d-adf158a52ab2:narrative_observed:current:obs_signal:player_0"
            }
          ]
        },
        {
          "id": "fact_2",
          "text": "货船的导航与传感器阵列在跃迁中报废，无法自行精确定位，也无法确认第二跳是否安全。",
          "certainty": "known",
          "sources": []
        },
        {
          "id": "fact_3",
          "text": "那段求救带有一组重复的认证码和一段压缩坐标，认证格式读不出来源。",
          "certainty": "known",
          "sources": [
            {
              "kind": "committed",
              "eventId": "init:gen_44f203d6-946d-4df0-b56d-adf158a52ab2:narrative_observed:current:obs_npc_report:player_0"
            }
          ]
        }
      ],
      "text": "母站那封加密求救，重复周期和信号强度稳不稳？能据此判断是有人在主动发，还是自动信标在循环吗？"
    }
  ],
  "future": [
    {
      "unitKey": "npc_reply_current",
      "kind": "answer",
      "intent": null,
      "brief": "同意先确认船体状态再谈回应；导航与传感器阵列确实在跃迁里报废，靠它们没法精确定位，也确认不了第二跳安不安全；至于残余动力和推进还能不能响应，我无法从现有仪表确认，不知道。",
      "inquiries": [],
      "answers": [],
      "prerequisiteFactIds": [],
      "topicFactIds": [],
      "facts": [
        {
          "id": "fact_2",
          "text": "货船的导航与传感器阵列在跃迁中报废，无法自行精确定位，也无法确认第二跳是否安全。",
          "certainty": "known",
          "sources": []
        }
      ],
      "text": "同意。先确认船体状态，再谈回应母站。\n导航和传感器阵列确实在跃迁里报废了。靠它们，我们没法自行精确定位，也确认不了第二跳安不安全。\n至于残余动力和推进还能不能响应——现有仪表上，我确认不了。不知道。",
      "selected": {
        "label": "先别急着回应。导航和传感器阵列在跃迁里报废了，我们连自己能不能动都没确认——先搞清楚船还能不能动，再谈回应母站。",
        "historicalChoice": true,
        "contract": {
          "intent": "challenge",
          "inquiries": [],
          "brief": "对立刻回应求救的打算提出质疑，主张先确认货船残余的导航与动力，搞清楚自身还能不能动，再谈回应母站。\n正文必须明确包含：[fact_2，known] 货船的导航与传感器阵列在跃迁中报废，无法自行精确定位，也无法确认第二跳是否安全。。\n完整保留以上本轮内容的对象、回答、未知范围、态度、协助方式与条件；只调整措辞，不把相关话题背景补进内容稿，不增加线索、任务、路线或行动结果。",
          "prerequisiteFactIds": []
        }
      }
    },
    {
      "unitKey": "choices_current",
      "candidateId": "current_scene_choice_2",
      "kind": "option",
      "intent": "ask",
      "brief": "询问薇拉：母站那封加密求救的重复周期和信号强度是否稳定，能不能据此判断它仍是有人在主动发送，还是自动信标在循环。",
      "inquiries": [
        {
          "factId": "fact_0",
          "aspects": [
            "time",
            "reliability"
          ]
        }
      ],
      "answers": [],
      "prerequisiteFactIds": [],
      "topicFactIds": [
        "fact_0"
      ],
      "facts": [
        {
          "id": "fact_0",
          "text": "『长夜号』脱离跃迁后仪表全灭，唯一仍有响应的是来自失联母站的加密求救信号，正在重复发送。",
          "certainty": "known",
          "sources": [
            {
              "kind": "committed",
              "eventId": "init:gen_44f203d6-946d-4df0-b56d-adf158a52ab2:narrative_observed:current:obs_signal:player_0"
            }
          ]
        },
        {
          "id": "fact_2",
          "text": "货船的导航与传感器阵列在跃迁中报废，无法自行精确定位，也无法确认第二跳是否安全。",
          "certainty": "known",
          "sources": []
        },
        {
          "id": "fact_3",
          "text": "那段求救带有一组重复的认证码和一段压缩坐标，认证格式读不出来源。",
          "certainty": "known",
          "sources": [
            {
              "kind": "committed",
              "eventId": "init:gen_44f203d6-946d-4df0-b56d-adf158a52ab2:narrative_observed:current:obs_npc_report:player_0"
            }
          ]
        }
      ],
      "text": "母站那封加密求救，重复周期和信号强度稳不稳？能据此判断是有人在主动发，还是自动信标在循环吗？"
    }
  ],
  "wuxia": [
    {
      "unitKey": "u_choices_open",
      "candidateId": "r_ask_token",
      "kind": "option",
      "intent": "ask",
      "brief": "沈孤鸿把那枚青铜令牌放到桌上，问柳素娘：这牌子她认不认得，刻雪纹的式样出自哪一路人，最近镇上有没有谁佩过这样的东西。",
      "inquiries": [],
      "answers": [],
      "prerequisiteFactIds": [],
      "topicFactIds": [
        "fact_0",
        "fact_3"
      ],
      "facts": [
        {
          "id": "fact_0",
          "text": "寒山派的青铜令牌，剑柄处刻着细雪纹，江湖上识得这式样的人不多。",
          "certainty": "known",
          "sources": []
        },
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
      ],
      "text": "这枚青铜令牌，剑柄上刻着细雪纹——你认不认得？这式样出自哪一路人？最近镇上，可有谁佩过这样的东西？"
    },
    {
      "unitKey": "u_choices_open",
      "candidateId": "r_probe_ambush",
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
          "id": "fact_0",
          "text": "寒山派的青铜令牌，剑柄处刻着细雪纹，江湖上识得这式样的人不多。",
          "certainty": "known",
          "sources": []
        },
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
      ],
      "text": "你说被劫的不止一辆，可见你早知情。这几夜住店的生面孔，城外那三起案子，你一次说清楚。"
    }
  ],
  "missingSource": [
    {
      "unitKey": "character_current",
      "kind": "answer",
      "intent": "admit_unknown",
      "brief": "明确表示不知道消息来自谁，也无法判断它有几分可信。",
      "inquiries": [
        {
          "factId": "fact_rumor",
          "aspects": [
            "source",
            "reliability"
          ]
        }
      ],
      "answers": [
        {
          "factId": "fact_rumor",
          "aspect": "source",
          "outcome": "unknown",
          "answerFactIds": []
        },
        {
          "factId": "fact_rumor",
          "aspect": "reliability",
          "outcome": "unknown",
          "answerFactIds": []
        }
      ],
      "prerequisiteFactIds": [],
      "topicFactIds": [
        "fact_rumor"
      ],
      "facts": [],
      "text": "可信不可信，我说不准。",
      "selected": {
        "label": "这个传闻是谁传来的，有几分可信？",
        "historicalChoice": true,
        "contract": {
          "intent": "ask",
          "brief": "这个传闻是谁传来的，有几分可信？",
          "inquiries": [
            {
              "factId": "fact_rumor",
              "aspects": [
                "source",
                "reliability"
              ]
            }
          ]
        }
      }
    }
  ]
} satisfies Record<string, readonly DialogueReviewSubject[]>;
export const realReviewFailures = [
  {
    "source": "visible-corpus-and-contracts.json:wuxia-opening:review0",
    "verdict": {
      "verdict": "reject",
      "violations": [
        {
          "scope": "planning",
          "unitKey": "u_choices_open",
          "type": "extra_inquiry",
          "aspect": "identity",
          "candidateId": "r_ask_token"
        },
        {
          "scope": "planning",
          "unitKey": "u_choices_open",
          "type": "extra_inquiry",
          "aspect": "source",
          "candidateId": "r_ask_token"
        },
        {
          "scope": "planning",
          "unitKey": "u_choices_open",
          "type": "extra_inquiry",
          "aspect": "identity",
          "candidateId": "r_probe_ambush"
        },
        {
          "scope": "planning",
          "unitKey": "u_choices_open",
          "type": "extra_inquiry",
          "aspect": "cause",
          "candidateId": "r_probe_ambush"
        }
      ]
    }
  },
  {
    "source": "contrast-results.json:reject_1",
    "verdict": {
      "verdict": "reject",
      "violations": [
        {
          "scope": "expression",
          "unitKey": "candidate_1",
          "type": "extra_inquiry",
          "aspect": "source"
        }
      ]
    }
  },
  {
    "source": "visible-corpus-and-contracts.json:science_fiction-branch0:review1",
    "verdict": {
      "verdict": "reject",
      "violations": [
        {
          "scope": "expression",
          "unitKey": "c1",
          "type": "missing_response",
          "aspect": "source"
        },
        {
          "scope": "expression",
          "unitKey": "c1",
          "type": "missing_response",
          "aspect": "purpose"
        }
      ]
    }
  },
  {
    "source": "visible-corpus-and-contracts.json:science_fiction-branch1:review0",
    "verdict": {
      "verdict": "reject",
      "violations": [
        {
          "scope": "planning",
          "unitKey": "npc_reply_current",
          "type": "intent_mismatch",
          "aspect": null
        },
        {
          "scope": "expression",
          "unitKey": "npc_reply_current",
          "type": "missing_response",
          "aspect": "reliability"
        },
        {
          "scope": "expression",
          "unitKey": "npc_reply_current",
          "type": "missing_response",
          "aspect": "time"
        }
      ]
    }
  }
];
