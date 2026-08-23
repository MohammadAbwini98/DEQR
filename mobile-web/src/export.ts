/**
 * Handing a verified file to the user, without ever holding it.
 *
 * Export used to be one line: build a `File` from the bytes the receiver was
 * holding and offer it. That works up to the point where the receiver stops
 * holding the bytes - which is the whole of Phase 06 - and past the point where
 * a file fits in a tab's memory, which is the reason for Phase 06.
 *
 * So there are two routes, and the difference between them is where the bytes
 * come from:
 *
 * - **`bytes`** - v1, and a small v2 transfer that fell back to the in-memory
 *   store. The file is already resident; a `File` over it costs nothing new.
 * - **`opfs`** - the large route. `getFile()` on a file handle returns a `File`
 *   that *refers to* the entry on disk; its bytes are read by whatever consumes
 *   it, when it consumes it. Wrapping that in `new File([entry], name)` to give
 *   it the user's filename keeps the reference - blob parts are stored by
 *   reference, not copied into the heap - so a gigabyte-sized export allocates
 *   a descriptor, not a gigabyte.
 *
 * ## What iOS actually allows, and what is not being claimed
 *
 * `showSaveFilePicker` does not exist on iOS, so a "save to Files" that streams
 * is not available to a web receiver. What exists is the share sheet
 * (`navigator.share` with `files`) and an anchor download. Both take a `File`,
 * which is why the file-backed `File` above matters so much: it is the only way
 * to reach either of them without first materialising the payload.
 *
 * Whether iOS itself will accept an arbitrarily large file through the share
 * sheet is **not known here and is not claimed anywhere in this build**. Apple
 * publishes no limit, the behaviour has changed between releases, and the
 * honest answer is that it needs measuring on a device - which is Phase 11's
 * job. What this module guarantees is that DEQR is not the component that
 * imposes a ceiling: it never copies, never concatenates, and never allocates
 * proportionally to the file.
 *
 * ## Cleanup
 *
 * A working file outlives its export by design - the share sheet is
 * asynchronous and the user may cancel it - so deletion is a separate,
 * explicit call the UI makes once the export has settled and the session is
 * being cleared.
 */

import {
  isReceiverSessionFile,
  isReceiverSessionPath,
  type DirectoryHandleLike,
  type StorageEnvironment,
  defaultEnvironment,
} from './opfs';
import type { VerifiedSource } from './worker-protocol';

export type ExportMode = 'share' | 'download';

export interface ExportableFile {
  filename: string;
  mimeType: string;
  source: VerifiedSource;
}

/** Why an export could not be offered. Enumerated; these reach the UI. */
export class ExportError extends Error {
  constructor(readonly code: 'EXPORT_SOURCE_MISSING' | 'EXPORT_UNSUPPORTED', message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/**
 * Resolves a verified transfer to a `File` the platform will take.
 *
 * Separated from the offering step so the memory claim can be tested directly:
 * a test can hold this `File` for a transfer far larger than the heap and
 * assert that nothing proportional to it was allocated.
 */
export async function fileForExport(
  transfer: ExportableFile,
  environment: StorageEnvironment = defaultEnvironment(),
): Promise<File> {
  const type = transfer.mimeType || 'application/octet-stream';

  if (transfer.source.kind === 'bytes') {
    const bytes = transfer.source.bytes;
    return new File([bytes], transfer.filename, { type });
  }

  const entry = await openSessionFile(transfer.source.path, transfer.source.file, environment);
  if (!entry) {
    throw new ExportError('EXPORT_SOURCE_MISSING', 'The verified file is no longer on this device.');
  }
  // Renamed, not rebuilt. The new `File` references the same backing entry.
  return new File([entry], transfer.filename, { type });
}

/**
 * Offers the file to the user, preferring the share sheet.
 *
 * `canShare` is asked rather than assumed: iOS refuses file shares in some
 * contexts (a non-secure origin, certain in-app browsers) and a `share` that
 * rejects there would leave the user with no file and no explanation. The
 * anchor download is the fallback and works in every browser this receiver
 * supports.
 */
export async function exportVerifiedFile(
  transfer: ExportableFile,
  environment: StorageEnvironment = defaultEnvironment(),
): Promise<ExportMode> {
  const file = await fileForExport(transfer, environment);

  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: transfer.filename });
    return 'share';
  }

  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = transfer.filename;
  anchor.click();
  // Revoked on the next turn rather than immediately: the navigation the click
  // starts has to have read the URL first.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return 'download';
}

/**
 * Deletes a session's working data after its export has settled.
 *
 * Called by the UI, not by the export itself, because a share sheet the user
 * dismisses is a cancelled export and the file has to still be there for the
 * second attempt. Never throws: a working file that outlives its session is
 * swept on the next one.
 */
export async function discardExportedSession(
  source: VerifiedSource,
  environment: StorageEnvironment = defaultEnvironment(),
): Promise<boolean> {
  if (source.kind !== 'opfs' || !isReceiverSessionPath(source.path)) return false;
  const getDirectory = environment.storage?.getDirectory;
  if (typeof getDirectory !== 'function') return false;
  try {
    const root = await getDirectory.call(environment.storage);
    let directory: DirectoryHandleLike = root;
    for (const part of source.path.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(part, { create: false });
    }
    await directory.removeEntry(source.path[source.path.length - 1], { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens the payload file of one session directory.
 *
 * The path and the filename are re-validated here even though both were
 * validated when the message carrying them arrived. They are the arguments to
 * a file open and they reached this process over a port; checking them twice
 * costs a regex and a set membership, and removes any dependence on the order
 * in which those two checks happen to run.
 *
 * `isReceiverSessionFile` admits `data.part` and `original.part` and nothing
 * else - notably not `checkpoint.json`, which is metadata this receiver writes
 * and is never something to hand to a share sheet.
 */
async function openSessionFile(
  path: readonly string[],
  file: string,
  environment: StorageEnvironment,
): Promise<File | null> {
  if (!isReceiverSessionPath(path) || !isReceiverSessionFile(file)) return null;
  const getDirectory = environment.storage?.getDirectory;
  if (typeof getDirectory !== 'function') return null;
  try {
    let directory: DirectoryHandleLike = await getDirectory.call(environment.storage);
    for (const part of path) {
      directory = await directory.getDirectoryHandle(part, { create: false });
    }
    const handle = await directory.getFileHandle(file, { create: false });
    return (await handle.getFile()) as File;
  } catch {
    return null;
  }
}
