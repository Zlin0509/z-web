declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    NOTEBOOK_OWNER_EMAIL?: string;
  }
}
