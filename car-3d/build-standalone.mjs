/* Rebuilds the single-file copies of both pages, with three.js and the shared
   car model inlined, so each is one self-contained .html with no vendor/ folder
   and no sibling script next to it.
     index.html  ->  standalone.html        (studio viewer)
     drive.html  ->  drive-standalone.html  (driving sim)
   Neither keeps the <!doctype>/<head> wrapper - that is the form the Artifact
   publisher expects, and browsers open them fine as-is.
   Run:  node build-standalone.mjs                                          */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const three = readFileSync(join(dir, 'vendor', 'three.min.js'), 'utf8');
const model = readFileSync(join(dir, 'car-model.js'), 'utf8');

function build(src, out) {
  let html = readFileSync(join(dir, src), 'utf8');

  html = html.replace(/^[\s\S]*?<meta name="viewport"[^>]*>\s*/, '')
             .replace(/<\/head>\s*<body>\s*/, '')
             .replace(/\s*<\/body>\s*<\/html>\s*$/, '\n');

  /* three.js + its CDN fallback, then the shared model, all inlined */
  const tags = /<script src="vendor\/three\.min\.js"><\/script>\s*<script>[\s\S]*?<\/script>\s*<script src="car-model\.js"><\/script>/;
  if (!tags.test(html)) throw new Error('script tags not found in ' + src);
  html = html.replace(tags, '<script>\n' + three + '\n</script>\n<script>\n' + model + '\n</script>');

  /* links between the two pages have to point at the standalone copies */
  html = html.replace(/href="drive\.html"/g, 'href="drive-standalone.html"')
             .replace(/href="index\.html"/g, 'href="standalone.html"');

  html = '<meta charset="utf-8">\n' +
    '<script>document.documentElement.lang="he";document.documentElement.dir="rtl";<\/script>\n' + html;

  writeFileSync(join(dir, out), html);
  console.log(out.padEnd(24), (html.length / 1024).toFixed(0) + ' KB');
}

build('index.html', 'standalone.html');
build('drive.html', 'drive-standalone.html');
