import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX = "docs/Agent文档索引.md";
const PHASE_PAGE = "docs/agent/当前开发阶段.md";
const PHASE_CONFIG = "docs/agent/current-phase.json";
const CURRENT_TREES = ["docs/agent", "docs/策划文档", "docs/operations"];
const HISTORY = /^docs\/(?:archive|superpowers|设想|真机测试)\//;

function markdownFiles(root, directory, recursive = true) {
  const full = resolve(root, directory);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    // Never follow directory links, especially foundation/worktree links.
    if (entry.isDirectory()) return recursive ? markdownFiles(root, path) : [];
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

function withoutFences(text) {
  let fence = null;
  return text.split(/\r?\n/).map(line => {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
      return "";
    }
    return fence ? "" : line;
  }).join("\n");
}

function linkTargets(text, file, errors) {
  const refs = new Map();
  const targets = [];
  const normalize = key => key.trim().replace(/\s+/g, " ").toLowerCase();
  for (const match of text.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm)) {
    refs.set(normalize(match[1]), match[2] ?? match[3]);
  }
  // Balance destination parentheses; angle destinations also permit spaces.
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*/g)) {
    let cursor = match.index + match[0].length;
    let target = "";
    if (text[cursor] === "<") {
      const end = text.indexOf(">", cursor + 1);
      if (end !== -1) target = text.slice(cursor + 1, end);
    } else {
      let depth = 0;
      for (; cursor < text.length; cursor++) {
        const char = text[cursor];
        if (char === "\\" && cursor + 1 < text.length) { target += text[++cursor]; continue; }
        if (char === "(" ) depth++;
        if (char === ")") { if (depth === 0) break; depth--; }
        if (/\s/.test(char) && depth === 0) break;
        target += char;
      }
    }
    if (target) targets.push(target);
  }
  for (const match of text.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const key = normalize(match[2] || match[1]);
    if (refs.has(key)) targets.push(refs.get(key));
    else errors.push(`${file}: 未定义的文档引用 [${key}]`);
  }
  // Shortcut references are links only when a matching definition exists.
  for (const match of text.matchAll(/\[([^\]\n]+)\](?![\[(])/g)) {
    if (refs.has(normalize(match[1]))) targets.push(refs.get(normalize(match[1])));
  }
  return [...new Set(targets)];
}

function headingAnchors(markdown) {
  const anchors = new Set();
  const counts = new Map();
  const text = withoutFences(markdown);
  for (const match of text.matchAll(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/gm)) {
    const label = match[1].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "").trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "").replace(/ /g, "-");
    let slug = label;
    let count = counts.get(label) ?? 0;
    while (anchors.has(slug)) slug = `${label}-${++count}`;
    counts.set(label, count);
    anchors.add(slug);
  }
  for (const match of text.matchAll(/<(?:a|[a-z][a-z\d]*)\b[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) anchors.add(match[1]);
  return anchors;
}

function localTarget(root, file, target, errors, fromRoot = false) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return null;
  let path;
  try { path = decodeURIComponent(target.split(/[?#]/)[0]); }
  catch { errors.push(`${file}: 链接编码无效：${target}`); return null; }
  const absolute = path ? resolve(fromRoot ? root : dirname(resolve(root, file)), path) : resolve(root, file);
  const rel = relative(root, absolute).replaceAll("\\", "/");
  if (isAbsolute(path) || rel === ".." || rel.startsWith("../")) {
    errors.push(`${file}: 本地链接越出仓库：${target}`);
    return null;
  }
  if (!existsSync(absolute)) errors.push(`${file}: 本地链接不存在：${target}`);
  if (existsSync(absolute) && rel.endsWith(".md") && target.includes("#")) {
    try {
      const fragment = decodeURIComponent(target.slice(target.indexOf("#") + 1));
      if (fragment && !headingAnchors(readFileSync(absolute, "utf8")).has(fragment)) {
        errors.push(`${file}: Markdown 标题锚点不存在：${target}`);
      }
    } catch { errors.push(`${file}: 链接锚点编码无效：${target}`); }
  }
  return rel;
}

export function checkDocs(root) {
  root = resolve(root);
  const errors = [], warnings = [];
  const rootDocs = markdownFiles(root, "docs", false)
    .filter(file => !/\d{4}-\d{2}-\d{2}/.test(file) && file !== "docs/想法.md");
  const files = [...new Set(["AGENTS.md", "README.md", ...rootDocs,
    ...CURRENT_TREES.flatMap(dir => markdownFiles(root, dir))])].sort();
  let scripts = {};
  try { scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts ?? {}; }
  catch { errors.push("package.json: 无法读取 npm 命令定义"); }
  const texts = new Map();
  const links = new Map();
  const paragraphs = new Map();
  for (const file of files) {
    if (!existsSync(resolve(root, file))) { errors.push(`必要入口不存在：${file}`); continue; }
    const raw = readFileSync(resolve(root, file), "utf8");
    const text = withoutFences(raw);
    texts.set(file, text);
    for (const match of raw.matchAll(/\bnpm run ([a-zA-Z0-9][\w:.-]*)/g)) {
      if (!Object.hasOwn(scripts, match[1])) errors.push(`${file}: npm 命令不存在：${match[1]}`);
    }
    const targets = linkTargets(text.replace(/`[^`\n]*`/g, ""), file, errors)
      .map(target => localTarget(root, file, target, errors)).filter(Boolean);
    // Backtick document paths are still used by plans and existing system docs.
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      const path = match[1];
      if (/[<>*{}|]/.test(path) || /\s/.test(path)) continue;
      if (/\.md(?:#.*)?$/.test(path)) {
        const target = localTarget(root, file, path, errors, /^(?:docs\/|AGENTS\.md$|README\.md$)/.test(path));
        if (target) targets.push(target);
      } else if (/^(?:src|scripts)\/[\w\u0080-\uffff./-]+\.(?:ts|tsx|mjs|json)(?::\d+)?$/.test(path)) {
        const source = path.replace(/:\d+$/, "");
        if (!existsSync(resolve(root, source))) warnings.push(`${file}: 源码入口不存在：${source}`);
      }
    }
    links.set(file, targets);
    for (const line of text.split("\n")) {
      if (/^#{1,6}\s+.*(?:\d{4}-\d{2}-\d{2}|最近维护|上一阶段|修复批次|历史实现|回归记录|维护记录)/.test(line)) {
        warnings.push(`${file}: 当前文档含历史更新标题：${line}`);
      }
    }
    const limit = file === INDEX ? 6000 : file === "AGENTS.md" || file === PHASE_PAGE ? 3500 : 10000;
    if (raw.length > limit) warnings.push(`${file}: 篇幅 ${raw.length} 字符超过软阈值 ${limit}，请检查是否需要按职责精简`);
    for (const paragraph of text.split(/\n\s*\n/)) {
      const value = paragraph.replace(/\s+/g, " ").trim();
      if (value.length < 180 || value.startsWith("|")) continue;
      const owners = paragraphs.get(value) ?? new Set();
      owners.add(file); paragraphs.set(value, owners);
    }
  }
  for (const owners of paragraphs.values()) {
    if (owners.size > 1) warnings.push(`重复长段落：${[...owners].join("、")}；请选择唯一维护位置`);
  }
  if (!texts.has(INDEX)) errors.push(`必要入口不存在：${INDEX}`);
  const indexed = new Set(links.get(INDEX) ?? []);
  for (const target of indexed) {
    if (HISTORY.test(target) && !target.endsWith("/README.md")) {
      errors.push(`${INDEX}: 系统入口不能直接指向历史资料：${target}`);
    }
    if (target.endsWith(".md") && existsSync(resolve(root, target))) {
      const intro = readFileSync(resolve(root, target), "utf8");
      if (/(?:\bRETIRED\b|状态[：:]\s*已退役)/i.test(intro)) {
        errors.push(`${INDEX}: 系统入口指向退役文档：${target}`);
      }
    }
  }
  for (const file of files.filter(f => f.startsWith("docs/agent/") && !/\/(?:README|template)\.md$/.test(f))) {
    if (!indexed.has(file)) errors.push(`${file}: 系统文档未登记到 Agent 文档索引`);
  }
  if (!(links.get(PHASE_PAGE) ?? []).includes(PHASE_CONFIG)) {
    errors.push(`${PHASE_PAGE}: 必须链接 current-phase.json 作为阶段状态唯一来源`);
  }
  try {
    const config = JSON.parse(readFileSync(resolve(root, PHASE_CONFIG), "utf8"));
    if (typeof config.plan !== "string" || !Array.isArray(config.entryDocs)) {
      errors.push(`${PHASE_CONFIG}: plan 必须为路径，entryDocs 必须为数组`);
    } else {
      for (const path of [config.plan, ...config.entryDocs]) {
        if (typeof path !== "string") errors.push(`${PHASE_CONFIG}: 文档路径必须为字符串`);
        else localTarget(root, PHASE_CONFIG, path, errors, true);
      }
    }
    const page = texts.get(PHASE_PAGE) ?? "";
    const mutable = [config.phase, config.status, config.implementationStatus, config.targetBranch, config.plan]
      .filter(value => typeof value === "string" && value.length > 2);
    const explicitStatus = /(?:状态|status|implementationStatus)\s*[：:=]\s*`?(?:planned|not_started|implemented|completed|merged|已规划|未实施|已完成)/i.test(page);
    if (mutable.some(value => page.includes(value)) || explicitStatus || (links.get(PHASE_PAGE) ?? []).includes(config.plan)) {
      errors.push(`${PHASE_PAGE}: 重复阶段状态或执行指针；只链接 JSON，不手写可漂移副本`);
    }
  } catch (error) {
    errors.push(`${PHASE_CONFIG}: 无法读取阶段 JSON（${error.code ?? error.name}）`);
  }
  return { files, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const result = checkDocs(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  for (const warning of result.warnings) console.warn(`提醒：${warning}`);
  for (const error of result.errors) console.error(`错误：${error}`);
  console.log(`文档检查：${result.files.length} 份当前文档，${result.errors.length} 个错误，${result.warnings.length} 个提醒。`);
  process.exitCode = result.errors.length ? 1 : 0;
}
