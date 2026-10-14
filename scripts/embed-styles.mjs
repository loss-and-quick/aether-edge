import { readFileSync, writeFileSync } from 'node:fs';

const cssPath = new URL('../src/styles.generated.css', import.meta.url);
const outputPath = new URL('../src/styles.generated.ts', import.meta.url);
const css = readFileSync(cssPath, 'utf8');

writeFileSync(outputPath, `export const styles = ${JSON.stringify(css)};\n`);
