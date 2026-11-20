// @vitest-environment node
// Audit 2026-10-18: writes land strictly in order, so ONE refused write
// blocked every later save, showed nothing, and Export/git flushes hung. A
// deferred class/text edit or post save now re-applies itself to bytes that
// moved under it; a true conflict is one deterministic issue the user can discard.
import 'fake-indexeddb/auto';
import * as Y from 'yjs';
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import { putProjectFiles } from '@/db/projectFiles';
import { projectFsRuntime } from '@/test/projectFsRuntime';
import { markFilesTruth, unmarkFilesTruth } from '@/utils/localMode';
import { acceptProjectEdit } from '../acceptance';
import { classCommands } from '../classCommands';
import { textCommands } from '../textCommands';
import { flushDurableSourceWrites } from '../sourceMaterialization';
import { getMaterializationStatus } from '../materializer';
import { prepareSourceCommand, dispatchSourceCommand } from '../commandReceipts';
import { sourceVersion } from '../sourceIdentity';
import type { MaterializationCommand } from '../types';

let projectId: string, sequence = 0;
const file = 'src/pages/index.astro';
const page = '<html>\n<head>\n<title>T</title>\n</head>\n<body>\n<main class="p-2">Привет</main>\n<p class="x">Two</p>\n</body>\n</html>\n';
const origin = { armed: true, pageFile: file };
const postFile = 'src/content/blog/hello.mdx';
const post = '---\ntitle: "Hi"\ndraft: true\n---\nOne.\n\nTwo.\n\nThree.\n';
let runtime: ReturnType<typeof projectFsRuntime>;
let outsideWrite: string | null = null, outsideAt = file;
let doc: Y.Doc;
// An outside writer landing after the edit's acceptance. "Newer" compares the file mtime with the edit's acceptedAt
// (commandReceipts acceptedAfter); Linux stamps mtime from a coarse kernel clock that can read a few ms behind Date.now(),
// so a write right after acceptance could look older and the edit overwrote it (pre-push flake). Pin it clearly after.
const outside = (bytes: string, at = file) => {
  const path = join(runtime.root, at);
  writeFileSync(path, bytes);
  const later = new Date(Date.now() + 1000);
  utimesSync(path, later, later);
};
beforeEach(async () => {
  // The materializer keeps per-project state for the session: one id per test.
  projectId = `browser_refused_write_recovery_${++sequence}`;
  await db.delete(); await db.open(); markFilesTruth(projectId);
  doc = new Y.Doc(); doc.getMap('meta').set('projectId', projectId);
  outsideWrite = null; outsideAt = file;
  runtime = projectFsRuntime(projectId, { [file]: page, [postFile]: post }, { beforeCommand: async () => {
    if (outsideWrite !== null) { outside(outsideWrite, outsideAt); outsideWrite = null; }
  } });
});
afterEach(() => { runtime.close(); unmarkFilesTruth(projectId); doc.destroy(); });
const accept = (operationId: string, commands: MaterializationCommand[]) =>
  acceptProjectEdit(doc, { projectId, operationId, mutate: () => {}, commands });
const classEdit = (line: number, from: string, to: string, bytes = page) =>
  classCommands({ file, line, column: 1, sourceVersion: sourceVersion(bytes) }, to, from, origin);
/** A post editor save as acceptPreparedPostWrite records it: prepared against `post`. */
const postSave = (afterSource: string): MaterializationCommand[] => [{ kind: 'post-write', payload: {
  collection: 'blog', slug: 'hello', frontmatter: { title: 'Hi' }, body: afterSource.split('---\n')[2],
  expectedSource: post, preparedFiles: [{ file: postFile, beforeSource: post, afterSource }] } }];

// Owner 2026-11-08: an agent in the terminal sed-edited a post the editor still
// had a save queued for → "changed outside Starquix", and every later save of
// the project held behind it.
it('re-applies a pending post save to a post an outside agent changed elsewhere', async () => {
  const mine = post.replace('One.', 'One, by me.');
  await accept('post', postSave(mine));
  outside(post.replace('Three.', 'Three, by the agent.'), postFile);
  await flushDurableSourceWrites(projectId);
  expect(runtime.read(postFile)).toBe(mine.replace('Three.', 'Three, by the agent.'));
});

it('re-applies a post save whose file moved between preparation and the write', async () => {
  const mine = post.replace('draft: true', 'draft: false');
  await accept('post', postSave(mine));
  outsideAt = postFile; outsideWrite = post.replace('Two.', 'Two, by the agent.');
  await flushDurableSourceWrites(projectId);
  expect(runtime.read(postFile)).toBe(mine.replace('Two.', 'Two, by the agent.'));
}, 10_000);

it('lets the newer agent text win the same words of a queued post save — no issue, no block (owner: newest wins)', async () => {
  await accept('post', postSave(post.replace('One.', 'First.').replace('Three.', 'Three, by me.')));
  outside(post.replace('One.', 'Uno.'), postFile);
  await flushDurableSourceWrites(projectId);
  expect(getMaterializationStatus(projectId).issue).toBeNull();
  expect(runtime.read(postFile)).toBe(post.replace('One.', 'Uno.').replace('Three.', 'Three, by me.'));
});

it('re-applies a pending class edit to a file an outside editor changed elsewhere', async () => {
  await accept('class', classEdit(6, 'p-2', 'p-4'));
  outside(page.replace('<title>T</title>', '<title>Сайт</title>'));
  await flushDurableSourceWrites(projectId);
  expect(runtime.read(file)).toBe(page.replace('<title>T</title>', '<title>Сайт</title>').replace('p-2', 'p-4'));
});

it('re-applies a pending text edit to a file an outside editor changed elsewhere', async () => {
  await accept('text', textCommands({ file, line: 6, column: 1, sourceVersion: sourceVersion(page) }, 'Пока', origin));
  outside(page.replace('Two', 'Два'));
  await flushDurableSourceWrites(projectId);
  expect(runtime.read(file)).toBe(page.replace('Two', 'Два').replace('Привет', 'Пока'));
});

it('re-applies an edit whose file moved between preparation and the write', async () => {
  await accept('class', classEdit(6, 'p-2', 'p-4'));
  outsideWrite = page.replace('Two', 'Два');
  await flushDurableSourceWrites(projectId);
  expect(runtime.read(file)).toBe(page.replace('Two', 'Два').replace('p-2', 'p-4'));
}, 10_000);

it('lets a newer outside class on the same element win, and later edits still save — no issue', async () => {
  await accept('mine', classEdit(6, 'p-2', 'p-4'));
  await accept('later', classEdit(7, 'x', 'y'));
  outside(page.replace('p-2', 'p-8'));
  await flushDurableSourceWrites(projectId);
  expect(runtime.read(file)).toBe(page.replace('p-2', 'p-8').replace('class="x"', 'class="y"'));
  expect(getMaterializationStatus(projectId).issue).toBeNull();
});

it('records a verified disk write even when the Dexie mirror row went stale', async () => {
  await putProjectFiles(projectId, [{ path: file, content: new TextEncoder().encode('stale mirror') }]);
  await prepareSourceCommand(projectId, 'stale', { kind: 'file-batch', payload: { files: [{ file, beforeSource: page, afterSource: page.replace('Two', 'Два') }] } });
  expect(await dispatchSourceCommand(projectId, 'stale')).toMatchObject({ status: 'written' });
  const row = await db.projectFiles.get(`${projectId}:${file}`);
  expect(new TextDecoder().decode(row!.content)).toBe(page.replace('Two', 'Два'));
});
