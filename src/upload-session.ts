import { Dropbox, files } from "dropbox";
import stream from "node:stream";
import {
  GlobalOptions,
  makePromiseLimiter,
} from "@blaahaj/dropbox-hacking-util";

import fixedChunkStream from "./fixed-chunk-stream.js";

const PART_SIZE = 4194304; // 4 MB

const defaultLimiter = makePromiseLimiter<void>(5, "part-limiter");

export default (
  dbx: Dropbox,
  commitInfo: files.CommitInfo,
  readable: stream.Readable,
  globalOptions: GlobalOptions,
): Promise<files.FileMetadata> =>
  dbx
    .filesUploadSessionStart({
      session_type: { ".tag": "concurrent" },
    })
    .then((v) => v.result.session_id)
    .then(
      (sessionId) =>
        new Promise<files.FileMetadata>((resolve, reject) => {
          const debug = (...args: unknown[]) => {
            if (globalOptions.debugUpload) console.debug(...args);
          };

          debug(`Using multi-part upload session=${sessionId}`);

          const partPromises: Promise<void>[] = [];

          let totalOffset = 0;
          let totalParts = 0;
          let partsCompleted = 0;
          let previous: { buffer: Buffer; offset: number } | undefined =
            undefined;

          const flushPrevious = (finalPart: boolean) => {
            if (previous) {
              const { buffer, offset } = previous;
              previous = undefined;

              if (!finalPart && buffer.length !== PART_SIZE)
                throw new Error("Bad non-final buffer size");

              const logPrefix = `${commitInfo.path} part offset=${offset} size=${buffer.length} finalPart=${finalPart}`;
              debug(`${logPrefix} starting`);
              ++totalParts;

              partPromises.push(
                defaultLimiter.submit(
                  () =>
                    dbx
                      .filesUploadSessionAppendV2({
                        cursor: { session_id: sessionId, offset },
                        contents: buffer,
                        close: finalPart,
                      })
                      .then(() => {
                        ++partsCompleted;
                        debug(
                          `${logPrefix} completed (${partsCompleted}/${totalParts} parts)`,
                        );
                      })
                      .catch((err: Error) => {
                        debug(`${logPrefix} failed`, err);
                        reject(err);
                      }),
                  logPrefix,
                ),
              );
            }
          };

          const onChunk = (buffer: Buffer): void => {
            flushPrevious(false);
            previous = { buffer, offset: totalOffset };
            totalOffset += buffer.length;
          };

          const onEnd = (): void => {
            flushPrevious(true);

            Promise.all(partPromises)
              .then(() => {
                debug(`all parts completed, finish, offset=${totalOffset}`);

                return (
                  dbx
                    .filesUploadSessionFinish({
                      cursor: {
                        session_id: sessionId,
                        offset: totalOffset,
                      },
                      commit: commitInfo,
                    })
                    .then((r) => {
                      debug("finish completed");
                      resolve(r.result);
                    })
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    .catch((err: any) => {
                      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                      debug(`finish failed`, JSON.stringify(err.error));
                      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                      reject(err);
                    })
                );
              })
              .catch(() => undefined);
          };

          fixedChunkStream(PART_SIZE, readable, onChunk, onEnd, reject);
        }),
    );
