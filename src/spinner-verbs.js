import { readSystemSettings } from "./settings-file.js";

/**
 * spinner 动词库：等待期显示的 "xxxxxing…" 文案来源。
 *
 * 这些词与实际执行的操作无关，纯粹是等待期的趣味装饰。它由 StatusVerb 渲染，
 * 表示「本回合仍在进行中」，因此整回合常驻、不会被工具调用或 Thinking 抢占；
 * 更具体的活动内容由下方的 ActivitySlot 单独展示。
 */
export const SPINNER_VERBS = [
  "Accomplishing",
  "Actioning",
  "Actualizing",
  "Architecting",
  "Baking",
  "Beaming",
  "Befuddling",
  "Billowing",
  "Blanching",
  "Bloviating",
  "Boogieing",
  "Boondoggling",
  "Booping",
  "Bootstrapping",
  "Brewing",
  "Burrowing",
  "Calculating",
  "Canoodling",
  "Caramelizing",
  "Cascading",
  "Catapulting",
  "Cerebrating",
  "Channeling",
  "Choreographing",
  "Churning",
  "Coalescing",
  "Cogitating",
  "Combobulating",
  "Composing",
  "Computing",
  "Concocting",
  "Considering",
  "Contemplating",
  "Cooking",
  "Crafting",
  "Creating",
  "Crunching",
  "Crystallizing",
  "Cultivating",
  "Deciphering",
  "Deliberating",
  "Determining",
  "Dilly-dallying",
  "Discombobulating",
  "Doing",
  "Doodling",
  "Drizzling",
  "Ebbing",
  "Effecting",
  "Elucidating",
  "Embellishing",
  "Enchanting",
  "Envisioning",
  "Evaporating",
  "Fermenting",
  "Fiddle-faddling",
  "Finagling",
  "Flambéing",
  "Flibbertigibbeting",
  "Flowing",
  "Flummoxing",
  "Fluttering",
  "Forging",
  "Forming",
  "Frolicking",
  "Frosting",
  "Gallivanting",
  "Galloping",
  "Garnishing",
  "Generating",
  "Germinating",
  "Gesticulating",
  "Grooving",
  "Gusting",
  "Harmonizing",
  "Hashing",
  "Hatching",
  "Herding",
  "Honking",
  "Hullaballooing",
  "Hyperspacing",
  "Ideating",
  "Imagining",
  "Improvising",
  "Incubating",
  "Inferring",
  "Infusing",
  "Ionizing",
  "Jitterbugging",
  "Julienning",
  "Kneading",
  "Leavening",
  "Levitating",
  "Lollygagging",
  "Manifesting",
  "Marinating",
  "Meandering",
  "Metamorphosing",
  "Misting",
  "Mooning",
  "Moonwalking",
  "Moseying",
  "Mulling",
  "Musing",
  "Mustering",
  "Nebulizing",
  "Nesting",
  "Noodling",
  "Nucleating",
  "Orbiting",
  "Orchestrating",
  "Osmosing",
  "Perambulating",
  "Percolating",
  "Perusing",
  "Philosophising",
  "Photosynthesizing",
  "Pollinating",
  "Pondering",
  "Pontificating",
  "Pouncing",
  "Precipitating",
  "Prestidigitating",
  "Processing",
  "Proofing",
  "Propagating",
  "Puttering",
  "Puzzling",
  "Quantumizing",
  "Razzle-dazzling",
  "Razzmatazzing",
  "Recombobulating",
  "Reticulating",
  "Roosting",
  "Ruminating",
  "Sautéing",
  "Scampering",
  "Schlepping",
  "Scurrying",
  "Seasoning",
  "Shenaniganing",
  "Shimmying",
  "Simmering",
  "Skedaddling",
  "Sketching",
  "Slithering",
  "Smooshing",
  "Spelunking",
  "Spinning",
  "Sprouting",
  "Stewing",
  "Sublimating",
  "Swirling",
  "Swooping",
  "Symbioting",
  "Synthesizing",
  "Tempering",
  "Thinking",
  "Thundering",
  "Tinkering",
  "Tomfoolering",
  "Topsy-turvying",
  "Transfiguring",
  "Transmuting",
  "Twisting",
  "Undulating",
  "Unfurling",
  "Unravelling",
  "Vibing",
  "Waddling",
  "Wandering",
  "Warping",
  "Whatchamacalliting",
  "Whirlpooling",
  "Whirring",
  "Whisking",
  "Wibbling",
  "Working",
  "Wrangling",
  "Zesting",
  "Zigzagging",
];

/**
 * 归一化 spinnerVerbs 配置。
 * - 缺省或非法 → null，调用方使用默认词库
 * - mode 仅接受 "append" / "replace"，缺省按 "append"
 * - verbs 过滤非字符串与空白项；为空时视为无效配置
 */
export function normalizeSpinnerVerbsConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Array.isArray(value.verbs)) return null;
  const verbs = value.verbs
    .filter((verb) => typeof verb === "string")
    .map((verb) => verb.trim())
    .filter((verb) => verb.length > 0);
  if (verbs.length === 0) return null;
  const mode = value.mode === "replace" ? "replace" : "append";
  return { mode, verbs };
}

/**
 * 读取生效的动词库：~/.miro/settings.json 的 spinnerVerbs 可追加或替换默认词。
 * 配置形如 { mode: "append" | "replace", verbs: ["Hacking"] }。
 */
export function getSpinnerVerbs(settings = readSystemSettings()) {
  const config = normalizeSpinnerVerbsConfig(settings.spinnerVerbs);
  if (!config) return SPINNER_VERBS;
  if (config.mode === "replace") return config.verbs;
  return [...SPINNER_VERBS, ...config.verbs];
}

/** 随机取一个动词；词库异常为空时兜底 "Working"。 */
export function sampleSpinnerVerb(verbs = getSpinnerVerbs()) {
  if (!Array.isArray(verbs) || verbs.length === 0) return "Working";
  return verbs[Math.floor(Math.random() * verbs.length)] ?? "Working";
}
