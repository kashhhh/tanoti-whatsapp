import fs from "node:fs";
import path from "node:path";
import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";
import morgan from "morgan";

const BUILD_PATH = "./build/server/index.js";
const build = await import(BUILD_PATH);

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

app.use(compression());
app.use(
  "/assets",
  express.static("build/client/assets", { immutable: true, maxAge: "1y" }),
);
app.use(express.static("build/client", { maxAge: "1h" }));
if (fs.existsSync("public")) {
  app.use(express.static("public", { maxAge: "1h" }));
}
app.use(morgan("tiny"));

app.all(
  "*",
  createRequestHandler({
    build,
    mode: process.env.NODE_ENV,
  }),
);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[server] http://localhost:${port}`);
});
