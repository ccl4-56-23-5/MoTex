const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { compile, detectTex, legacyDisplayPlaceholders } = require('../desktop/latex.cjs');

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGOImLoLD2IYlcaGAOwPpT3Nz4BfAAAAAElFTkSuQmCC';
const image = { id: 'dot', name: '测试图.png', data: png };
const reference = {
  key: 'sample+2026/1',
  bib: '@article{sample+2026/1,\n  title={测量方法},\n  author={Example, T.},\n  year={2026},\n  journal={Methods \\& Models}\n}',
};
const body = [
  '# 一级 $E=mc^2$', '## 二级', '### 三级', '#### 四级', '##### 五级', '###### 六级', '',
  '中英文混排，行内公式 $x_i^2$，价格为 \\$1，符号 #_&%{}~^。',
  '', '$$', '\\begin{aligned} x &= \\frac{1}{2} \\\\ y &= 3 \\end{aligned}', '$$', '',
  '![示意图](asset:dot)', '', 'MoyeChapterAlphaMarker', '',
  ':::chapter 第二章测试', '', '# 本章首节', '', 'MoyeChapterBetaMarker',
].join('\n');
const citation = '[@' + reference.key + ']';
const citedBody = body + '\n\n正文引用' + citation + ' 与再次引用' + citation + '。';
const legacyCitedBody = citedBody.replace('$$\n\\begin{aligned}', () => '$$\n$$\n\\begin{aligned}');

function checkFormulaBoundaries() {
  assert.deepEqual(legacyDisplayPlaceholders('$$\n$$\n\\theta_x^2\n$$\n\n![图](asset:dot)'), [1]);
  assert.deepEqual(legacyDisplayPlaceholders('$$\r\n$$\r\n\\theta_x^2\r\n$$\r\n\r\n# 标题'), [1]);
  assert.deepEqual(legacyDisplayPlaceholders('$$\n$$\n\\theta_x^2\n$$\nx^2\n$$'), []);
  assert.deepEqual(legacyDisplayPlaceholders('$$\n$$\n普通正文\n$$'), []);
  assert.deepEqual(legacyDisplayPlaceholders('$$\n$$\n\\theta_x^2\n普通正文\n$$'), []);
  assert.deepEqual(legacyDisplayPlaceholders('$$\n$$\n\\text{普通正文}\n$$'), []);
  assert.deepEqual(legacyDisplayPlaceholders('$$\n\\theta_x^2'), []);
  assert.deepEqual(legacyDisplayPlaceholders('$$x^2$$\n\n$$\ny^2\n$$'), []);
}

function pdfPages(result, installed) {
  const pdftotext = path.join(installed.bin, process.platform === 'win32' ? 'pdftotext.exe' : 'pdftotext');
  if (!fs.existsSync(pdftotext)) return null;
  return execFileSync(pdftotext, ['-enc', 'UTF-8', result.pdfPath, '-'], { encoding: 'utf8', windowsHide: true }).split('\f');
}

function checkPdf(result, bibFile, installed) {
  assert.ok(result.ok, result.log);
  assert.equal(fs.readFileSync(result.pdfPath).subarray(0, 5).toString(), '%PDF-');
  assert.ok(result.sourceFiles.includes('main.tex') && result.sourceFiles.includes('image-1.png'));
  assert.ok(result.sourceFiles.includes(bibFile));
  for (const name of result.sourceFiles) assert.ok(fs.statSync(path.join(result.workDir, name)).isFile());
  assert.equal((fs.readFileSync(path.join(result.workDir, bibFile), 'utf8').match(/@article/g) || []).length, 1);
  const lastTexLog = fs.readFileSync(path.join(result.workDir, 'main.log'), 'utf8');
  assert.doesNotMatch(lastTexLog, /Citation .* undefined|Empty bibliography/);

  const pages = pdfPages(result, installed);
  if (!pages) return;
  const alpha = pages.findIndex(page => page.includes('MoyeChapterAlphaMarker'));
  const beta = pages.findIndex(page => page.includes('MoyeChapterBetaMarker'));
  assert.ok(alpha >= 0 && beta > alpha, 'An explicit chapter must start on a new PDF page.');
  assert.match(pages.join('').replace(/\s/g, ''), /参考文献/);
  assert.match(pages.join(''), /MoyeAbstractMarker/);
}

async function verify() {
  checkFormulaBoundaries();
  const installed = detectTex(process.argv[2]);
  assert.ok(installed.ready && installed.biber, 'Tests require XeLaTeX and Biber in the same bin directory.');
  const parent = fs.realpathSync(os.tmpdir());
  const workDir = fs.mkdtempSync(path.join(parent, 'moye-qa-'));
  try {
    const unicodeDir = path.join(workDir, '中文 工作区');
    fs.mkdirSync(unicodeDir);
    const templateRoot = path.join(workDir, 'template');
    fs.cpSync(path.join(__dirname, '..', 'template'), templateRoot, { recursive: true });
    assert.equal(detectTex(unicodeDir).ready, false, 'An explicitly invalid path must not fall back to PATH.');
    const base = {
      title: '墨页 & TeX', images: [image], bin: installed.bin, workDir: unicodeDir, templateRoot,
      metadata: {
        author: '测试姓名', advisor: '测试导师', titleEn: 'Example thesis', discipline: '测试学科',
        school: '测试学院', date: '2026-11-06', abstract: 'MoyeAbstractMarker 测试摘要。',
      },
    };
    const timed = async (label, options) => {
      const start = performance.now();
      const result = await compile({ ...base, ...options });
      assert.ok(result.ok, label + '\n' + result.log);
      console.log('PASS', label, JSON.stringify(result.passes), Math.round(performance.now() - start) + 'ms');
      return result;
    };
    const note = { template: 'note', text: citedBody, references: [reference] };
    const pending = timed('ElegantNote legacy formula and image', { ...note, text: legacyCitedBody });
    const busy = await compile({ ...base, ...note });
    assert.equal(busy.ok, false);
    assert.match(busy.log, /已在编译/);
    const cold = await pending;
    checkPdf(cold, 'reference.bib', installed);
    assert.ok(cold.sourceFiles.includes('template/elegantnote/elegantnote.cls'));
    assert.equal(cold.passes.biber, 1);
    assert.match(cold.log, /旧版公式兼容：编译转换时跳过第 \d+ 行的多余 \$\$/);
    assert.match(fs.readFileSync(cold.sourcePath, 'utf8'), /\\\[\n\\begin\{aligned\}/);
    const normalized = await timed('Corrected source reuses the equivalent build', note);
    assert.equal(normalized.reused, true);
    assert.doesNotMatch(normalized.log, /旧版公式兼容/);

    const warmInput = { ...note, text: citedBody.replace('中英文混排', '混排中英文') };
    const warm = await timed('ElegantNote text-only edit', warmInput);
    checkPdf(warm, 'reference.bib', installed);
    assert.deepEqual(warm.passes, { xelatex: 1, biber: 0 });

    const warmBytes = fs.readFileSync(warm.pdfPath);
    const broken = await compile({ ...base, ...warmInput, text: warmInput.text + '\n\n$x\\right)$' });
    assert.equal(broken.ok, false, 'A failed candidate must not become the current build.');
    assert.equal(broken.passes.xelatex, 1, 'The engine-level failure must reach XeLaTeX.');
    assert.deepEqual(fs.readFileSync(warm.pdfPath), warmBytes, 'The last PDF must survive a failed compilation.');
    const same = await timed('Recovered exact build and legacy template alias', { ...warmInput, template: 'journal' });
    assert.deepEqual(same.passes, { xelatex: 0, biber: 0 });
    assert.equal(same.reused, true);
    assert.equal(same.pdfPath, warm.pdfPath);

    const updated = await timed('Changed bibliography', {
      ...warmInput, references: [{ ...reference, bib: reference.bib.replace('测量方法', '测量方案') }],
    });
    assert.equal(updated.passes.biber, 1, 'Changing a cited record requires rerunning Biber.');
    checkPdf(updated, 'reference.bib', installed);

    const thesis = await timed('XJTU doctorate legacy formula and image', { ...note, template: 'thesis', text: legacyCitedBody });
    checkPdf(thesis, 'references.bib', installed);
    assert.ok(thesis.sourceFiles.includes('template/xjtu/XJTU-thesis.cls'));
    assert.equal(thesis.passes.biber, 1);
    assert.match(thesis.log, /旧版公式兼容/);
    const warmThesis = await timed('XJTU doctorate text-only edit', {
      ...note, template: 'thesis', text: citedBody.replace('中英文混排', '混排中英文'),
    });
    checkPdf(warmThesis, 'references.bib', installed);
    assert.deepEqual(warmThesis.passes, { xelatex: 1, biber: 0 });
    const renamedThesis = await timed('XJTU updated table of contents', {
      ...note, template: 'thesis', text: citedBody.replace('第二章测试', '第二章改名'),
    });
    assert.equal(renamedThesis.passes.biber, 0);
    const renamedPages = pdfPages(renamedThesis, installed);
    if (renamedPages) {
      const text = renamedPages.join('').replace(/\s/g, '');
      assert.doesNotMatch(text, /第二章测试/);
      assert.ok((text.match(/第二章改名/g) || []).length >= 2, 'The updated title must appear in the body and table of contents.');
    }
    const cases = [
      ['危险输入 $\\input{outside.tex}$', /不支持的命令/],
      ['$$\n\\begin{document}\n$$', /不支持的公式环境/],
      ['$$\nx^2', /缺少结束/],
      ['$$\nx^2\n![公式内图片](asset:dot)\n$$', /第 3 行的图片位于第 1 行/],
      ['$$\nx^2\n:::chapter 公式内章节\n$$', /第 3 行的章节位于第 1 行/],
      ['$$\nx^2\n# 公式内标题\n$$', /第 3 行的标题位于第 1 行/],
      ['![丢失](asset:absent)', /未保存/],
      ['文献[@absent]', /不在项目中/],
      ['文献' + citation, /不支持的命令/, [{ ...reference, bib: '@article{' + reference.key + ',title={\\input{outside.tex}}}' }]],
      ['文献' + citation, /额外的 BibLaTeX 数据/, [{ ...reference, bib: reference.bib + '\n@preamble{bad}' }]],
    ];
    for (const [text, expected, references] of cases) {
      const result = await compile({ ...base, template: 'note', text, references });
      assert.equal(result.ok, false);
      assert.match(result.log, expected);
    }
    console.log('PASS input validation', cases.length, 'cases');
  } finally {
    assert.equal(path.dirname(fs.realpathSync(workDir)), parent);
    assert.match(path.basename(workDir), /^moye-qa-/);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

verify().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
