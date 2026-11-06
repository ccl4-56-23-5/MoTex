const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { chapterPattern, headingPattern, imagePattern, readDisplayMath, legacyDisplayPlaceholders } = require('../renderer/formula-structure.mjs');

const xelatex = process.platform === 'win32' ? 'xelatex.exe' : 'xelatex';
const biber = process.platform === 'win32' ? 'biber.exe' : 'biber';
const maxImageBytes = 15 * 1024 * 1024;
const keyPattern = /^[A-Za-z0-9_.:+\/-]{1,120}$/;
const headings = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'deepheading'];

const templateFolders = { note: 'elegantnote', thesis: 'xjtu' };
const templateEntry = 'moye-template.tex';
const cacheState = 'last-success.json';
const contentsFiles = ['main.out', 'main.toc', 'main.toe', 'main.lof', 'main.lot'];
const auxFiles = ['main.aux', ...contentsFiles];
const invalidControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const activeWorkspaces = new Set();

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function texLiveBins(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^\d{4}$/.test(entry.name))
      .map(entry => entry.name)
      .sort()
      .reverse()
      .map(version => path.join(root, version, 'bin', 'windows'));
  } catch {
    return [];
  }
}

function detectTex(configuredBin = '') {
  const configured = typeof configuredBin === 'string' ? configuredBin.trim().replace(/^"(.*)"$/, '$1') : '';
  const systemBins = (process.env.PATH || '').split(path.delimiter).map(entry => entry.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const candidates = configured ? [path.resolve(configured)] : [
    ...systemBins,
    ...(process.platform === 'win32' ? [...texLiveBins('D:\\program\\texlive'), ...texLiveBins('C:\\texlive')] : []),
  ];
  for (const bin of candidates.filter(entry => path.isAbsolute(entry))) {
    const compiler = path.join(bin, xelatex);
    const bibliography = path.join(bin, biber);
    if (!exists(compiler)) continue;
    return { bin, ready: true, compiler, biber: exists(bibliography) ? bibliography : null };
  }
  const message = configured ? '指定目录中找不到 XeLaTeX。请选择包含 xelatex.exe 的目录。' : '未找到 XeLaTeX。请在设置中指定本机 LaTeX 的 bin 目录。';
  return { bin: configured, ready: false, compiler: null, biber: null, message };
}

const escapedText = {
  '\\': String.raw`\textbackslash{}`,
  '{': '\\{', '}': '\\}', '#': '\\#', '$': '\\$', '%': '\\%', '&': '\\&', '_': '\\_',
  '^': String.raw`\textasciicircum{}`,
  '~': String.raw`\textasciitilde{}`,
};

function escapeText(text) {
  return String(text).replace(/[\\{}#$%&_^~]/g, char => escapedText[char]);
}

const fontCommands = 'text textnormal textup textmd textbf textit textsl textsc textrm textsf texttt emph textsuperscript textsubscript textbackslash textless textgreater textasciitilde textasciicircum';
const mathCommands = new Set((fontCommands + ' ' + [
  'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa varkappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega',
  'Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega digamma varGamma varDelta varTheta varLambda varXi varPi varSigma varUpsilon varPhi varPsi varOmega',
  'frac dfrac tfrac cfrac sqrt binom dbinom tbinom overset underset stackrel substack boxed cancel bcancel xcancel tag',
  'sum prod coprod int iint iiint iiiint oint idotsint limits nolimits lim limsup liminf sup inf min max arg det dim gcd hom ker Pr',
  'log ln exp sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth',
  'mathbb mathbf mathcal mathfrak mathit mathnormal mathrm mathscr mathsf mathtt boldsymbol pmb operatorname',
  'overline underline overbrace underbrace overrightarrow overleftarrow hat widehat bar vec dot ddot dddot breve acute grave check tilde widetilde',
  'left right middle big Big bigg Bigg bigl Bigl biggl Biggl bigr Bigr biggr Biggr bigm Bigm biggm Biggm',
  'langle rangle lbrace rbrace lvert rvert lVert rVert lceil rceil lfloor rfloor vert Vert backslash',
  'times cdot cdotp ast star circ bullet div pm mp cap cup uplus sqcap sqcup vee wedge setminus wr oplus ominus otimes oslash odot',
  'approx asymp cong equiv ge geq geqslant gg in le leq leqslant ll models ni not notin parallel perp prec preceq propto sim simeq subset subseteq supset supseteq succ succeq ne neq',
  'arrowvert Arrowvert uparrow Uparrow downarrow Downarrow updownarrow Updownarrow mapsto longmapsto to gets iff implies impliedby leftarrow rightarrow leftrightarrow Leftarrow Rightarrow Leftrightarrow longleftarrow longrightarrow longleftrightarrow Longleftarrow Longrightarrow Longleftrightarrow xrightarrow xleftarrow',
  'aleph hbar imath jmath ell Re Im emptyset varnothing nabla partial infty prime forall exists neg lnot land lor angle triangle square Box Diamond',
  'ldots cdots vdots ddots dots dotsc dotsb dotsm dotsi dotso quad qquad enspace thinspace medspace thickspace negthinspace phantom vphantom hphantom',
  'displaystyle textstyle scriptstyle scriptscriptstyle mspace mathord mathop mathbin mathrel mathopen mathclose mathpunct mathinner begin end',
].join(' ')).split(/\s+/));
const bibCommands = new Set((fontCommands + ' LaTeX TeX BibTeX enquote url nolinkurl H c v u r b d t i j o O l L ss aa AA ae AE oe OE').split(/\s+/));
const mathEnvironments = new Set(['aligned', 'alignedat', 'gathered', 'split', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix', 'array']);
const escapedSymbols = new Set(Array.from('{}#$%&_ ,;:!|/\\~^"\'`.=+-'));

// Math runs inside a generated document and accepts only known typesetting commands.
// Braces and environments must stay inside the expression's own boundary.
function validateTex(text, context, isMath) {
  let depth = 0;
  const environments = [];
  if (text.includes('^^') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new Error(context + '含有无效字符。');
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      const token = text.slice(index + 1).match(/^([A-Za-z]+|[^\r\n])/);
      if (!token) throw new Error(context + '的反斜线缺少命令。');
      const command = token[1];
      const allowed = (isMath ? mathCommands : bibCommands).has(command)
        || (command.length === 1 && escapedSymbols.has(command));
      if (!allowed) throw new Error(context + '含有此版本不支持的命令 \\' + command + '。');
      index += command.length;
      if (isMath && (command === 'begin' || command === 'end')) {
        const name = text.slice(index + 1).match(/^\s*\{([A-Za-z]+)\}/)?.[1];
        if (!mathEnvironments.has(name)) throw new Error(context + '含有不支持的公式环境。');
        if (command === 'begin') environments.push(name);
        else if (environments.pop() !== name) throw new Error(context + '的公式环境未配对。');
      }
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth < 0) throw new Error(context + '的大括号未配对。');
    }
    if (isMath && (char === '%' || char === '$' || char === '#')) {
      throw new Error(context + '中的字符 ' + char + ' 需要加反斜线。');
    }
  }
  if (depth !== 0) throw new Error(context + '的大括号未配对。');
  if (environments.length) throw new Error(context + '的公式环境未闭合。');
}

function bibliographyEntry(reference) {
  const text = reference.bib.trim();
  const head = text.match(/^@([A-Za-z]+)\s*\{\s*([^,\s]+)\s*,/);
  const context = '文献 ' + reference.key + ' ';
  if (!head || head[2] !== reference.key || /^(?:preamble|string|comment)$/i.test(head[1])) {
    throw new Error(context + '的 BibLaTeX 条目或引用键无效。');
  }
  validateTex(text, context, false);
  let depth = 0;
  for (let index = text.indexOf('{'); index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        if (text.slice(index + 1).trim()) throw new Error(context + '包含额外的 BibLaTeX 数据。');
        return text;
      }
    }
  }
  throw new Error(context + '的 BibLaTeX 条目未闭合。');
}

function writeImage(image, directory, sequence) {
  const data = String(image?.data ?? '');
  if (data.length > Math.ceil(maxImageBytes / 3) * 4 + 100) {
    throw new Error('图片 ' + image.id + ' 超过 15 MB。');
  }
  const match = data.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length % 4) throw new Error('图片 ' + image?.id + ' 格式无效，请插入 PNG 或 JPEG。');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > maxImageBytes) throw new Error('图片 ' + image.id + ' 超过 15 MB。');
  const png = match[1] === 'png';
  const signature = png ? '89504e470d0a1a0a' : 'ffd8ff';
  if (!bytes.toString('hex', 0, signature.length / 2).startsWith(signature)) {
    throw new Error('图片 ' + image.id + ' 的文件头与格式不一致。');
  }
  const filename = 'image-' + sequence + (png ? '.png' : '.jpg');
  fs.writeFileSync(path.join(directory, filename), bytes);
  return filename;
}

function convertDocument(text, directory, references, images) {
  const cited = new Map();
  const includedImages = new Map();
  const paragraphs = [];
  const output = [];
  const refs = new Map(references.filter(ref => keyPattern.test(ref?.key) && typeof ref?.bib === 'string').map(ref => [ref.key, ref]));
  const assets = new Map(images.map(image => [image?.id, image]));
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const placeholders = new Set(legacyDisplayPlaceholders(text));
  let chapterStarted = false;

  function inline(text, line) {
    const tokens = /\\\$|\[@([A-Za-z0-9_.:+\/-]{1,120})\]|\$((?:\\[^\r\n]|[^\\$\r\n])+)\$/g;
    let result = '';
    let cursor = 0;
    for (const match of text.matchAll(tokens)) {
      result += escapeText(text.slice(cursor, match.index));
      const [, key, formula] = match;
      if (key) {
        if (!refs.has(key)) throw new Error('第 ' + line + ' 行引用的文献 ' + key + ' 不在项目中。');
        if (!cited.has(key)) cited.set(key, bibliographyEntry(refs.get(key)));
        result += '\\cite{' + key + '}';
      } else if (formula) {
        validateTex(formula, '第 ' + line + ' 行的公式', true);
        result += '$' + formula + '$';
      } else {
        result += '\\$';
      }
      cursor = match.index + match[0].length;
    }
    return result + escapeText(text.slice(cursor));
  }

  function flushParagraph() {
    if (paragraphs.length) output.push(paragraphs.splice(0).join('\n'));
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const chapter = line.match(chapterPattern);
    const heading = line.match(headingPattern);
    const image = trimmed.match(imagePattern);
    if (!trimmed) {
      flushParagraph();
      continue;
    }
    if (chapter) {
      flushParagraph();
      output.push('\\MoyeChapter{' + inline(chapter[1].trim(), index + 1) + '}');
      chapterStarted = true;
      continue;
    }
    if (!chapterStarted) {
      output.push('\\MoyeImplicitChapter');
      chapterStarted = true;
    }
    if (trimmed.startsWith('$$')) {
      flushParagraph();
      const lineNumber = index + 1;
      const { end, formula, trailing } = readDisplayMath(lines, index, placeholders.has(index + 1));
      index = end;
      if (formula) {
        validateTex(formula, '第 ' + lineNumber + ' 行的公式', true);
        output.push('\\[\n' + formula + '\n\\]');
      }
      if (trailing) paragraphs.push(inline(trailing, index + 1));
    } else if (heading) {
      flushParagraph();
      output.push('\\' + headings[heading[1].length - 1] + '{' + inline(heading[2], index + 1) + '}');
    } else if (image) {
      flushParagraph();
      const [, caption, id] = image;
      if (!assets.has(id)) throw new Error('第 ' + (index + 1) + ' 行引用的图片 ' + id + ' 未保存。');
      if (!includedImages.has(id)) includedImages.set(id, writeImage(assets.get(id), directory, includedImages.size + 1));
      output.push([
        '\\begin{figure}[htbp]',
        '\\centering',
        '\\includegraphics[width=\\linewidth,height=.58\\textheight,keepaspectratio]{' + includedImages.get(id) + '}',
        '\\caption{' + escapeText(caption) + '}',
        '\\end{figure}',
      ].join('\n'));
    } else {
      paragraphs.push(inline(line, index + 1));
    }
  }
  flushParagraph();
  return {
    body: output.join('\n\n'), bib: [...cited.values()].join('\n\n'),
    imageFiles: [...includedImages.values()], placeholders,
  };
}

function texMetadata(value, fallback = '') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  if (invalidControls.test(value)) throw new Error('文档信息含有无效字符。');
  return escapeText(value.trim().replace(/[\r\n]+/g, ' '));
}

function texDocument(wrapper, { body, bib }, { kind, title, numbering, metadata }) {
  const preamble = [
    '\\usepackage{amsmath,amssymb,mathrsfs,cancel,graphicx}',
    '\\makeatletter',
    '\\newcounter{deepheading}[subparagraph]',
    '\\renewcommand{\\thedeepheading}{\\thesubparagraph.\\arabic{deepheading}}',
    '\\providecommand*{\\toclevel@deepheading}{6}',
    '\\providecommand*{\\theHdeepheading}{\\theHsubparagraph.\\arabic{deepheading}}',
    '\\newcommand{\\deepheading}[1]{\\par\\addvspace{1ex}\\noindent{\\bfseries\\ifnum\\value{secnumdepth}>5\\refstepcounter{deepheading}\\thedeepheading\\quad\\fi#1\\par}\\nobreak\\smallskip}',
    '\\makeatother',
    '\\setcounter{secnumdepth}{' + (numbering === 'none' ? -1 : 6) + '}',
  ].join('\n');
  const values = {
    PREAMBLE: preamble,
    BIB_SETUP: bib && kind === 'thesis' ? '\\addbibresource{references.bib}' : '',
    BODY: body,
    PRINT_BIB: bib ? '\\printbibliography[heading=bibintoc,title={参考文献}]' : '',
    TITLE: texMetadata(title, '未命名文档'),
    TITLE_EN: texMetadata(metadata?.titleEn),
    AUTHOR: texMetadata(metadata?.author),
    ADVISOR: texMetadata(metadata?.advisor),
    DISCIPLINE: texMetadata(metadata?.discipline),
    SCHOOL: texMetadata(metadata?.school),
    DATE: texMetadata(metadata?.date),
    ABSTRACT: texMetadata(metadata?.abstract),
  };
  for (const marker of ['PREAMBLE', 'BIB_SETUP', 'BODY', 'PRINT_BIB']) {
    if (!wrapper.includes('%%MOYE_' + marker + '%%')) throw new Error('模板入口缺少 ' + marker + ' 标记。');
  }
  return wrapper.replace(/%%MOYE_([A-Z_]+)%%/g, (_, token) => {
    if (!Object.hasOwn(values, token)) throw new Error('模板入口包含无法识别的标记 ' + token + '。');
    return values[token];
  });
}

function copyTemplate(templateRoot, kind, runDir) {
  const folder = templateFolders[kind];
  const source = path.join(templateRoot, folder);
  const entry = path.join(source, templateEntry);
  if (!exists(entry)) throw new Error('缺少 ' + (kind === 'thesis' ? '西安交通大学博士论文' : 'ElegantNote') + ' 模板入口。');
  const wrapper = fs.readFileSync(entry, 'utf8');
  const files = [];

  function copyDirectory(from, relative) {
    const to = path.join(runDir, relative);
    fs.mkdirSync(to, { recursive: true });
    const children = fs.readdirSync(from, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const child of children) {
      const sourcePath = path.join(from, child.name);
      const targetPath = relative + '/' + child.name;
      if (sourcePath === entry) continue;
      if (child.isDirectory()) copyDirectory(sourcePath, targetPath);
      else if (child.isFile()) {
        fs.copyFileSync(sourcePath, path.join(runDir, targetPath));
        files.push(targetPath);
      }
    }
  }

  copyDirectory(source, 'template/' + folder);
  return { wrapper, files };
}

function run(program, args, cwd, bin, timeout) {
  return new Promise(resolve => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = bin + path.delimiter + (process.env.PATH || '');
    env.openin_any = 'p';
    env.openout_any = 'p';
    env.shell_escape = 'f';
    const child = spawn(program, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    let timedOut = false;
    const add = chunk => { log = (log + chunk).slice(-48000); };
    child.stdout.setEncoding('utf8').on('data', add);
    child.stderr.setEncoding('utf8').on('data', add);
    child.once('error', error => add(error.message));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) add('\n运行超时。');
      resolve({ ok: !timedOut && code === 0, log });
    });
  });
}

function hashParts(parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part) : part;
    hash.update(String(bytes.length) + ':');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function hashFiles(directory, names) {
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(hashParts([name, fs.readFileSync(path.join(directory, name))]));
  }
  return hash.digest('hex');
}

function executableStamp(executable) {
  if (!executable) return '';
  const file = fs.statSync(executable);
  return JSON.stringify([fs.realpathSync(executable), file.size, file.mtimeMs]);
}

function safeRunDirectory(root, candidate) {
  try {
    if (!/^compile-[A-Za-z0-9]+$/.test(path.basename(candidate))) return false;
    if (path.dirname(candidate) !== root || !fs.lstatSync(candidate).isDirectory()) return false;
    return path.dirname(fs.realpathSync(candidate)) === root;
  } catch {
    return false;
  }
}

function readCache(root) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(root, cacheState), 'utf8'));
    if (state.version !== 1 || typeof state.directory !== 'string' || !/^compile-[A-Za-z0-9]+$/.test(state.directory)) return null;
    const directory = path.join(root, state.directory);
    return safeRunDirectory(root, directory) ? { ...state, directory } : null;
  } catch {
    return null;
  }
}

function writeCache(root, state) {
  const file = path.join(root, 'cache-' + randomUUID() + '.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, ...state }), { flag: 'wx' });
    fs.renameSync(file, path.join(root, cacheState));
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function removeRun(root, directory) {
  if (!safeRunDirectory(root, directory)) return;
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
}

function restoreAux(from, to, bib) {
  for (const name of bib ? [...auxFiles, 'main.bbl'] : auxFiles) {
    const source = path.join(from, name);
    if (exists(source)) fs.copyFileSync(source, path.join(to, name));
  }
}

function rerunNeeded(log) {
  return /Rerun to get (?:cross-references|outlines|\/PageLabels)|Label\(s\) may have changed|Please [^\r\n]*rerun LaTeX/i.test(log);
}

function contentsDigest(directory) {
  return hashFiles(directory, contentsFiles.filter(name => exists(path.join(directory, name))));
}

async function compile({
  text, template, title, numbering, metadata, references = [], images = [], bin, workDir,
  templateRoot = path.join(__dirname, '..', 'template'),
}) {
  const tex = detectTex(bin);
  if (!tex.ready) return { ok: false, log: tex.message };
  let root;
  let runDir;
  let locked = false;
  let retain = false;
  let log = '';
  const passes = { xelatex: 0, biber: 0 };
  try {
    if (typeof text !== 'string' || text.length > 2_000_000 || invalidControls.test(text)) {
      throw new Error('正文过长或含有无效字符。');
    }
    const kind = template === 'thesis' ? 'thesis' : 'note';
    root = fs.realpathSync(path.resolve(workDir));
    if (activeWorkspaces.has(root)) return { ok: false, log: '该工程已在编译，请等待当前编译完成。', passes };
    activeWorkspaces.add(root);
    locked = true;
    const previous = readCache(root);
    runDir = fs.mkdtempSync(path.join(root, 'compile-'));
    const converted = convertDocument(text, runDir, references, images);
    const recoveryLog = [...converted.placeholders]
      .map(index => '旧版公式兼容：编译转换时跳过第 ' + (index + 1) + ' 行的多余 $$。')
      .join('\n');
    const bibFile = kind === 'note' ? 'reference.bib' : 'references.bib';
    const { wrapper, files: templateFiles } = copyTemplate(templateRoot, kind, runDir);
    const documentFiles = ['main.tex', ...converted.imageFiles];
    const sourceFiles = [...documentFiles, ...templateFiles];
    fs.writeFileSync(path.join(runDir, 'main.tex'), texDocument(wrapper, converted, { kind, title, numbering, metadata }), 'utf8');
    if (converted.bib && !tex.biber) throw new Error('该项目含有引用，但配置的 LaTeX 目录中没有 Biber。');
    if (converted.bib || kind === 'note') {
      fs.writeFileSync(path.join(runDir, bibFile), converted.bib ? converted.bib + '\n' : '', 'utf8');
      documentFiles.push(bibFile);
      sourceFiles.push(bibFile);
    }

    const localDay = new Date().toLocaleDateString('en-CA');
    const context = hashParts([
      kind, wrapper, hashFiles(runDir, templateFiles), executableStamp(tex.compiler),
      executableStamp(tex.biber), converted.bib ? 'bib' : 'no-bib', localDay,
    ]);
    const inputDigest = hashParts([context, hashFiles(runDir, documentFiles)]);
    const compatible = previous?.context === context;
    const buildResult = (directory, buildLog, reused = false) => ({
      ok: true, workDir: directory, sourcePath: path.join(directory, 'main.tex'), sourceFiles,
      pdfPath: path.join(directory, 'main.pdf'), log: recoveryLog ? recoveryLog + '\n' + buildLog : buildLog, passes, reused,
    });
    if (compatible && previous.inputDigest === inputDigest
      && ['main.pdf', ...sourceFiles].every(name => exists(path.join(previous.directory, name)))) {
      return buildResult(previous.directory, '沿用与当前工程一致的 PDF。', true);
    }
    if (compatible) restoreAux(previous.directory, runDir, converted.bib);

    const texArgs = ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-synctex=1', 'main.tex'];
    async function execute(program, args, timeout) {
      const result = await run(program, args, runDir, tex.bin, timeout);
      log = (log + '\n> ' + path.basename(program) + ' ' + args.join(' ') + '\n' + result.log).slice(-70000);
      return result;
    }

    let bibDigest = compatible ? previous.bibDigest : null;
    let finalPass;
    let settled = false;
    while (passes.xelatex < 5) {
      const before = contentsDigest(runDir);
      passes.xelatex++;
      finalPass = await execute(tex.compiler, texArgs, 45000);
      if (!finalPass.ok) return { ok: false, log, passes };
      if (converted.bib) {
        if (!exists(path.join(runDir, 'main.bcf'))) throw new Error('模板未生成 Biber 所需的引用配置。');
        const required = hashFiles(runDir, ['main.bcf', bibFile]);
        if (bibDigest !== required || !exists(path.join(runDir, 'main.bbl'))) {
          if (passes.xelatex === 5) break;
          passes.biber++;
          const bibliography = await execute(tex.biber, ['--noconf', 'main'], 120000);
          if (!bibliography.ok) return { ok: false, log, passes };
          bibDigest = required;
          continue;
        }
      }
      if (!rerunNeeded(finalPass.log) && before === contentsDigest(runDir)) {
        settled = true;
        break;
      }
    }
    if (converted.bib && /LaTeX Warning: (?:Citation [^\r\n]+ undefined|Empty bibliography)/.test(finalPass.log)) {
      throw new Error('PDF 仍有未解析的引用，请检查文献条目。');
    }
    if (!settled) throw new Error('LaTeX 页码或引用在五遍编译后仍未稳定。');
    const result = buildResult(runDir, log);
    if (!exists(result.pdfPath)) throw new Error('编译器未生成 PDF。');
    writeCache(root, { directory: path.basename(runDir), context, inputDigest, bibDigest });
    retain = true;
    if (previous) removeRun(root, previous.directory);
    return result;
  } catch (error) {
    return { ok: false, log: log + '\n' + error.message, passes };
  } finally {
    if (!retain && runDir) removeRun(root, runDir);
    if (locked) activeWorkspaces.delete(root);
  }
}

module.exports = { detectTex, compile, legacyDisplayPlaceholders };
