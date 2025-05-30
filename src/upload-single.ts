import { Dropbox, files } from "dropbox";
import stream from "node:stream";
import {
  GlobalOptions,
  makePromiseLimiter,
} from "@blaahaj/dropbox-hacking-util";

export const MAX_SINGLE_UPLOAD_SIZE = 150_000_000;

const defaultLimiter = makePromiseLimiter<files.FileMetadata>(
  5,
  "single-upload-limiter",
);

export default (
  dbx: Dropbox,
  commitInfo: files.CommitInfo,
  readable: stream.Readable,
  globalOptions: GlobalOptions,
): Promise<files.FileMetadata> =>
  new Promise<files.FileMetadata>((resolve) => {
    const debug = (...args: unknown[]) => {
      if (globalOptions.debugUpload) console.debug(...args);
    };

    // Dumb version, where the whole contents goes into memory,
    // and the upload will fail if > 150MB.
    debug("Using single-part upload");

    const buffers: Buffer[] = [];

    readable.on("data", (buffer: Buffer) => {
      // console.debug(buffer);
      buffers.push(buffer);
    });

    readable.on("error", (err) => {
      console.error(err);
      process.exit(1);
    });

    readable.on("end", () => {
      const contents = Buffer.concat(buffers);
      // console.debug(`end, length=${contents.length}`);
      resolve(
        defaultLimiter.submit(
          () =>
            dbx
              .filesUpload({
                ...commitInfo,
                contents,
              })
              .then((r) => r.result),
          commitInfo.path,
        ),
      );
    });
  });
