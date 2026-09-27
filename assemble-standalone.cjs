// One-off assembly script: inlines dist/assets/*.css and *.js into ../TAA_Workspace.html.
// Builds the output from a fixed, known-good head/tail template rather than re-parsing
// the previous TAA_Workspace.html — splicing into "existing" content is fragile: a naive
// indexOf('<style>') can match literal text inside this very head comment (which mentions
// "<style>" as prose) instead of the real tag, silently emitting a head comment with no
// closing '-->' and swallowing the entire document (style/script/body) as comment text,
// leaving the app render blank. See TAA_KNOWLEDGE_BASE.md for the corruption post-mortem.
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');
const distIndexHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');

const jsMatch = distIndexHtml.match(/src="\/assets\/(index-[^"]+\.js)"/);
const cssMatch = distIndexHtml.match(/href="\/assets\/(index-[^"]+\.css)"/);
if (!jsMatch || !cssMatch) {
  throw new Error('Could not find built JS/CSS asset filenames in dist/index.html');
}

const jsContent = fs.readFileSync(path.join(distDir, 'assets', jsMatch[1]), 'utf8');
const cssContent = fs.readFileSync(path.join(distDir, 'assets', cssMatch[1]), 'utf8');

// Defensive check: HTML terminates a <script> element at the first literal "</script"
// substring, even inside a JS string — if the bundle ever contains that text, inlining
// it verbatim would truncate the script and corrupt the file the same way as the bug
// this script now avoids for the head comment.
if (jsContent.includes('</script')) {
  throw new Error('Built JS bundle contains a literal "</script" substring — inlining verbatim would corrupt the file. Escape it before splicing.');
}
if (cssContent.includes('</style')) {
  throw new Error('Built CSS contains a literal "</style" substring — inlining verbatim would corrupt the file. Escape it before splicing.');
}

const head = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TAA - Time & Attendance Automation</title>
    <meta name="description" content="Reconcile ASPECT schedules against Avaya CMS logins, audit Cognos discrepancies, and generate ASPECT correction CSVs and draft email action lists." />
    <!--
      Standalone single-file build. No external requests, no npm install, no
      build step to RUN it -- open this file directly in a browser.
      Built once from TAA_HTML/src via 'vite build', then a script inlined the
      resulting JS + CSS. To regenerate after editing TAA_HTML/src:
        1. cd TAA_HTML and run: npm run build
        2. cd TAA_HTML and run: node assemble-standalone.cjs
           (reads dist/index.html + dist/assets/*.{js,css} and rewrites this
           entire file from a fixed head/tail template plus those two files)
    -->
    <style>
`;

const middle = `
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
`;

const tail = `
    </script>
  </body>
</html>
`;

const outPath = path.join(__dirname, 'TAA_Workspace.html');
const finalHtml = head + cssContent + middle + jsContent + tail;

fs.writeFileSync(outPath, finalHtml, 'utf8');
console.log('Wrote', outPath, 'bytes:', Buffer.byteLength(finalHtml, 'utf8'));
