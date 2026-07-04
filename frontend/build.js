#!/usr/bin/env node
// =============================================================================
// build.js — Replace Cloudflare env var placeholders before deploy
// =============================================================================
// Cloudflare Pages runs this before publishing.
// It replaces {{VAR}} placeholders with actual env var values.
// =============================================================================

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, 'index.html');
const OUT_PATH = path.join(__dirname, 'dist', 'index.html');

// Read env vars (Cloudflare injects these in the build environment)
const vars = {
  '{{API_BASE_URL}}': process.env.API_BASE_URL || 'https://YOUR_ORACLE_VPS_IP',
  '{{API_KEY}}':      process.env.API_KEY      || 'sk-mkq-YOUR_KEY_HERE',
  '{{MODEL}}':        process.env.MODEL        || 'deepseek-r1-mkq',
};

let html = fs.readFileSync(INDEX_PATH, 'utf8');
for (const [placeholder, value] of Object.entries(vars)) {
  html = html.replaceAll(placeholder, value);
}

// Ensure dist directory and copy static assets
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(OUT_PATH, html);

// Copy _headers and any other static assets
const staticFiles = ['_headers'];
for (const f of staticFiles) {
  const src = path.join(__dirname, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(__dirname, 'dist', f));
  }
}

console.log('✓ Built frontend/dist/ with injected env vars');
console.log(`  API:  ${vars['{{API_BASE_URL}}']}`);
console.log(`  Key:  ${vars['{{API_KEY}}'].substring(0,12)}...`);
console.log(`  Model: ${vars['{{MODEL}}']}`);
