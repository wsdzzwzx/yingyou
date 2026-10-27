/* =====================================================================
 * 安全小卫士大闯关 — 剧情树数据（平台官方导出还原版）
 * ---------------------------------------------------------------------
 * 本文件的数据全部来自 TDream 平台导出的《安全小卫士大闯关.dwgame.json》，
 * 包含平台原文的：选项文字、QTE 提示、触发秒数（video_time）、拖拽目标坐标、
 * 结局文本、节点末尾分支（edges）与坏结局回跳点（auto navigate）。
 * 修改剧情只需改本文件，不需要动 engine.js。
 *
 * 【交互类型】
 *   qte        : 反应互动。kind: 'click' 点击 | 'hold' 长按 | 'swipe' 滑动(dir)
 *                at = 视频第几秒触发；window = 判定窗口秒数（平台为 10s）
 *                pos = 按钮在画面中的相对位置（平台 position）
 *                onFail: 'retry' 回到触发点重来 | 'jump' 跳到 failNext
 *   choice     : 分支/答题选项。correct: true 为正确项，答错回到触发点重来
 *                note = 答对后显示的浮层原文
 *   timedChoice: 限时选择，countdown 秒内未选 → 回退重来
 *   drag       : 拖拽交付。把 item 图拖到 target 区域（画面相对坐标 0~1）
 *   pano       : 360° 环顾（真实全景图拖动），hint 为提示语
 *
 * 【节点字段】
 *   video      : 视频文件（相对路径，含中文需编码，引擎已处理）
 *   next       : 唯一的后续节点
 *   choices    : 节点末尾的多分支（来自平台 edges 的 description + target）
 *   ending     : { kind:'good'|'normal'|'bad', icon, title, message }
 *   autoNext   : { at:秒, next } 片尾到点结算结局卡，并按平台自动回跳
 *   failAfter  : { count:N, next } 同节点累计失败 N 次后分流（平台 QTE 失败分流）
 * ===================================================================== */

window.STORY = {
  title: "安全小卫士大闯关",
  chapters: [
    {
      id: "ch1",
      name: "第一章 · 演练日",
      desc: "19 个分镜 · 2 条主线 · 8 个结局",
      start: "1-1",
      nodes: {

        /* ============================================================
         * 开场
         * ============================================================ */

        "1-1": {
          title: "1-1 吉祥物登场",
          scene: "清晨 · 晴 · 校门口",
          video: "video/v1.mp4",
          pano: { img: "pic/quanjing.jpg", hint: "请用鼠标拖动环顾四周", when: "end" },
          interactions: [
            { type: "qte", kind: "swipe", dir: "right", at: 15.7, window: 10, prompt: "点击！", pos: { x: 0.56, y: 0.74 }, onFail: "retry" },
            {
              type: "choice", at: 19.5, prompt: "牢记演练要领",
              options: [
                { label: "火灾来了怎么办？", correct: true, note: "弯腰低姿，湿巾捂口鼻；认准绿色安全灯，沿通道撤离；严禁乘坐电梯。" },
                { label: "地震来了怎么办？", correct: true, note: "就地避险，护头蹲伏；不慌乱、不跳楼、不拥挤；余震结束后有序撤离。" },
                { label: "继续游戏", pass: true }
              ]
            }
          ],
          next: "1-2"
        },

        "1-2": {
          title: "1-2 观察教学楼",
          scene: "早晨 · 晴 · 教室外部走廊",
          video: "video/v2.mp4",
          interactions: [
            {
              type: "choice", at: 3.47, prompt: "请选出正确答案",
              options: [
                { label: "绿色指示灯在火灾浓烟环境下，指引人员逃生", correct: true },
                { label: "绿色指示灯没有用" }
              ]
            },
            {
              type: "drag", at: 16.7, prompt: "将道具拖到正确位置",
              item: { label: "灭火器", img: "assets/item_extinguisher_small.png", at: { x: 0.09, y: 0.72 } },
              target: { x: 0.349, y: 0.311, w: 0.276, h: 0.595, label: "目标区域" }
            },
            {
              type: "timedChoice", at: 40, countdown: 10, prompt: "地震来了怎么办呢？",
              options: [
                { label: "快速躲到桌子底下", correct: true },
                { label: "站在教室里" }
              ]
            }
          ],
          next: "1-3"
        },

        "1-3": {
          title: "1-3 警报响起",
          scene: "早晨 · 晴 · 教室内部",
          video: "video/v3.mp4",
          interactions: [
            {
              type: "choice", at: 11.1, prompt: "警报响起，大家需要做什么？",
              options: [
                { label: "听指挥", correct: true },
                { label: "随便跑" }
              ]
            }
          ],
          choices: [
            { label: "先进行防火演练", next: "1-4" },
            { label: "先进行防震演练", next: "1-10" }
          ]
        },

        /* ============================================================
         * 防火线
         * ============================================================ */

        "1-4": {
          title: "1-4 1-F1 教室发现火情",
          scene: "上午 · 晴 · 教室门口及走廊",
          video: "video/v4.mp4",
          interactions: [
            {
              type: "choice", at: 16.83, prompt: "防火最重要的是什么？",
              options: [
                { label: "捂住口鼻、弯下腰，有序离开", correct: true },
                { label: "直立快跑冲向门口" },
                { label: "躲在角落里" }
              ]
            }
          ],
          choices: [
            { label: "拿湿毛巾捂住口鼻", next: "1-6" },
            { label: "直立快跑冲向门口", next: "1-19" },
            { label: "返回座位拿书包", next: "1-5" }
          ]
        },

        "1-6": {
          title: "1-6 1-F2 楼道逃生",
          scene: "上午 · 晴 · 教学楼楼道",
          video: "video/v6.mp4",
          interactions: [
            { type: "qte", kind: "swipe", dir: "up", at: 2.5, window: 10, prompt: "点击！", pos: { x: 0.56, y: 0.51 }, onFail: "retry" }
          ],
          next: "1-7"
        },

        "1-7": {
          title: "1-7 1-F3 高压节点 · 楼梯间连续逃生",
          scene: "上午 · 晴 · 楼梯间",
          video: "video/v7.mp4",
          interactions: [
            {
              type: "qte", kind: "swipe", dir: "right", at: 10.8, window: 10, prompt: "点击！",
              pos: { x: 0.5, y: 0.5 }, onFail: "retry",
              timeoutNext: "1-18"          // 完全没反应 → 一般结局「需要加强训练」
            }
          ],
          failAfter: { count: 2, next: "1-9" },  // 连续操作错误 → 坏结局「躲闪失败」
          next: "1-8"
        },

        "1-8": {
          title: "1-8 1-F3-A 三轮躲闪成功",
          scene: "上午 · 晴 · 楼梯间出口",
          video: "video/v8.mp4",
          next: "1-17"
        },

        "1-9": {
          title: "1-9 1-F3-B 躲闪失败",
          scene: "上午 · 晴 · 楼梯间",
          video: "video/v9.mp4",
          interactions: [
            { type: "qte", kind: "swipe", dir: "right", at: 5.1, window: 10, prompt: "点击！", pos: { x: 0.26, y: 0.35 }, onFail: "continue" },
            { type: "qte", kind: "swipe", dir: "down", at: 6.8, window: 10, prompt: "点击！", pos: { x: 0.5, y: 0.39 }, onFail: "continue" }
          ],
          ending: {
            kind: "bad", icon: "🚧",
            title: "坏结局 · 躲闪失败",
            message: "不够规范——躲闪不仅靠反应，还要提前观察，下次更细心哦！"
          },
          autoNext: { at: 22, next: "1-7" }
        },

        "1-19": {
          title: "1-19 1-F1-B 短结局 · 浓烟呛伤",
          scene: "上午 · 晴 · 教室及走廊",
          video: "video/v19.mp4",
          interactions: [
            { type: "qte", kind: "swipe", dir: "down", at: 21.1, window: 10, prompt: "点击！", pos: { x: 0.57, y: 0.2 }, onFail: "continue" }
          ],
          ending: {
            kind: "bad", icon: "😵",
            title: "短结局 · 浓烟呛伤",
            message: "逃生失败——浓烟中要弯腰低姿、用湿毛巾捂住口鼻哦！"
          },
          autoNext: { at: 25, next: "1-4" }
        },

        "1-5": {
          title: "1-5 1-F1-C 短结局 · 延误被困",
          scene: "上午 · 晴 · 教室",
          video: "video/v5.mp4",
          interactions: [
            { type: "qte", kind: "hold", at: 28.1, window: 10, prompt: "长按！", pos: { x: 0.39, y: 0.55 }, onFail: "retry" }
          ],
          ending: {
            kind: "bad", icon: "🔥",
            title: "短结局 · 延误被困",
            message: "撤离失败——逃生时不要返回取财物，延误时间会失去机会！"
          },
          autoNext: { at: 34.2, next: "1-4" }
        },

        /* ============================================================
         * 防震线
         * ============================================================ */

        "1-10": {
          title: "1-10 1-S1 教室地震避险",
          scene: "上午 · 晴 · 教室内部",
          video: "video/v10.mp4",
          interactions: [
            { type: "qte", kind: "swipe", dir: "down", at: 8, window: 10, prompt: "点击！", pos: { x: 0.5, y: 0.5 }, onFail: "retry" },
            { type: "qte", kind: "swipe", dir: "down", at: 26.2, window: 10, prompt: "点击！", pos: { x: 0.77, y: 0.56 }, onFail: "retry" }
          ],
          choices: [
            { label: "抱头蹲到课桌下", next: "1-13" },
            { label: "立刻冲出教室", next: "1-11" },
            { label: "站在窗户旁", next: "1-12" }
          ]
        },

        "1-11": {
          title: "1-11 1-S1-B 短结局 · 慌乱奔跑",
          scene: "上午 · 晴 · 教室及走廊",
          video: "video/v11.mp4",
          interactions: [
            // 平台该节点的「往外跑」互动：点两侧箭头调整安全区，小人进入安全区即通过（支持 ←/A、→/D）
            { type: "safezone", at: 3.5, window: 10, prompt: "点击！", pos: { x: 0.5, y: 0.5 }, onFail: "continue" },
            // 平台 20s 处的「低头快跑」下滑 QTE（官方截图还原）
            { type: "qte", kind: "swipe", dir: "down", at: 20, window: 10, prompt: "点击！", pos: { x: 0.5, y: 0.42 }, onFail: "retry" }
          ],
          ending: {
            kind: "bad", icon: "🏃",
            title: "短结局 · 慌乱奔跑",
            message: "避险失败——地震时不要慌张奔跑，容易引发踩踏事故！"
          },
          autoNext: { at: 25.9, next: "1-10" }
        },

        "1-12": {
          title: "1-12 1-S1-C 短结局 · 窗户危险",
          scene: "上午 · 晴 · 教室内部",
          video: "video/v12.mp4",
          interactions: [
            { type: "qte", kind: "swipe", dir: "down", at: 13.3, window: 10, prompt: "点击！", pos: { x: 0.5, y: 0.5 }, onFail: "retry" },
            { type: "qte", kind: "hold", at: 15.3, window: 10, prompt: "点击！", pos: { x: 0.5, y: 0.5 }, onFail: "retry" }
          ],
          ending: {
            kind: "bad", icon: "🪟",
            title: "短结局 · 窗户危险",
            message: "避险失败——窗户旁有碎玻璃和坠落物危险，应远离窗户！"
          },
          autoNext: { at: 28.8, next: "1-10" }
        },

        "1-13": {
          title: "1-13 1-S2 震后观察",
          scene: "上午 · 晴 · 教室内部及楼道",
          video: "video/v13.mp4",
          interactions: [
            { type: "qte", kind: "swipe", dir: "down", at: 0.6, window: 10, prompt: "点击！", pos: { x: 0.5, y: 0.5 }, onFail: "retry" },
            { type: "qte", kind: "hold", at: 30.3, window: 10, prompt: "点击！", pos: { x: 0.18, y: 0.76 }, onFail: "retry" }
          ],
          next: "1-14"
        },

        "1-14": {
          title: "1-14 1-S3 高压节点 · 楼道撤离 QTE",
          scene: "上午 · 晴 · 楼道与楼梯间",
          video: "video/v14.mp4",
          interactions: [
            { type: "qte", kind: "swipe", dir: "down", at: 10.4, window: 10, prompt: "点击！", pos: { x: 0.6, y: 0.21 }, onFail: "retry" },
            { type: "qte", kind: "swipe", dir: "down", at: 19.2, window: 10, prompt: "点击！", pos: { x: 0.8, y: 0.09 }, onFail: "retry" },
            { type: "qte", kind: "swipe", dir: "right", at: 26.5, window: 10, prompt: "点击！", pos: { x: 0.26, y: 0.52 }, onFail: "retry" },
            { type: "qte", kind: "swipe", dir: "down", at: 27.5, window: 10, prompt: "点击！", pos: { x: 0.5, y: 0.5 }, onFail: "retry" },
            { type: "qte", kind: "swipe", dir: "up", at: 36.5, window: 10, prompt: "点击！", pos: { x: 0.5, y: 0.5 }, onFail: "retry" }
          ],
          failAfter: { count: 3, next: "1-16" },  // 连续失败 3 次 → 坏结局「QTE 失败」
          next: "1-15"
        },

        "1-15": {
          title: "1-15 1-S3-A QTE 成功",
          scene: "上午 · 晴 · 教学楼出口",
          video: "video/v15.mp4",
          interactions: [
            { type: "qte", kind: "swipe", dir: "right", at: 5.4, window: 10, prompt: "点击！", pos: { x: 0.44, y: 0.23 }, onFail: "retry" }
          ],
          next: "1-17"
        },

        "1-16": {
          title: "1-16 1-S3-B QTE 失败",
          scene: "上午 · 晴 · 楼道与楼梯间",
          video: "video/v16.mp4",
          interactions: [
            { type: "qte", kind: "swipe", dir: "down", at: 2.7, window: 10, prompt: "点击！", pos: { x: 0.38, y: 0.13 }, onFail: "retry" },
            { type: "qte", kind: "swipe", dir: "down", at: 5.9, window: 10, prompt: "点击！", pos: { x: 0.5, y: 0.45 }, onFail: "retry" }
          ],
          ending: {
            kind: "bad", icon: "💥",
            title: "坏结局 · QTE 失败",
            message: "有惊无险——躲避时要专注听口令，别慌神哦！"
          },
          autoNext: { at: 32, next: "1-14" }
        },

        /* ============================================================
         * 结局
         * ============================================================ */

        "1-17": {
          title: "1-17 到达操场",
          scene: "上午 · 晴 · 楼下空旷操场",
          video: "video/v17.mp4",
          interactions: [
            {
              type: "choice", at: 23.2, prompt: "防火防震演练要注意什么？",
              options: [
                { label: "防火要用湿毛巾捂住口鼻，弯腰有序离开", correct: true, note: "正确" },
                { label: "地震要躲到桌子下面，跑的时候不能乱挤", correct: true, note: "正确" },
                { label: "随便跑" }
              ]
            },
            { type: "qte", kind: "swipe", dir: "right", at: 26.2, window: 10, prompt: "点击！", pos: { x: 0.5, y: 0.5 }, onFail: "continue" }
          ],
          ending: {
            kind: "good", icon: "🏆",
            title: "好结局 · 安全小卫士",
            message: "好结局——你冷静判断、动作规范，成功通过全部演练关卡，是当之无愧的安全小卫士！"
          }
        },

        "1-18": {
          title: "1-18 一般结局 · 需要加强训练",
          scene: "上午 · 晴 · 楼下空旷操场",
          video: "video/v18.mp4",
          interactions: [
            {
              type: "choice", at: 9.1, prompt: "今天为什么会砸到？",
              options: [
                { label: "躲闪时候慢了", correct: true },
                { label: "不是我的原因" }
              ]
            }
          ],
          ending: {
            kind: "normal", icon: "💪",
            title: "一般结局 · 需要加强训练",
            message: "一般结局——躲闪不仅靠反应，还要提前观察，安全知识还要多加练习！"
          },
          autoNext: { at: 14.9, next: "1-7" }
        }

      }
    }
  ]
};
