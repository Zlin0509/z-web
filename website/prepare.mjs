import { mkdir, cp, writeFile } from 'node:fs/promises';
import { readPosts } from './content.mjs';
await mkdir(new URL('../public/assets/', import.meta.url), { recursive: true });
await cp(new URL('./assets/', import.meta.url), new URL('../public/assets/', import.meta.url), { recursive: true });
await mkdir(new URL('./generated/', import.meta.url), { recursive: true });
const posts = await readPosts(new URL('./content/', import.meta.url), { includeDrafts: true });
await writeFile(new URL('./generated/seed.json', import.meta.url), JSON.stringify(posts.map(({html,toc,url,minutes,...post}) => post)));
console.log(`Prepared assets and ${posts.length} initial notes; existing database content is never overwritten.`);
