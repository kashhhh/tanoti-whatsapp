import React from "react";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider, Form, Link, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import ts from "typescript";

globalThis.__codPreviewLibs = { React, Form, Link, useFetcher, useLoaderData, useRevalidator, useEffect: React.useEffect,
  styles: new Proxy({}, { get: (_target, key) => key }),
};
const asModule = (source) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText).toString("base64")}`;
const toggleSource = readFileSync("app/components/CodMessagingToggle.tsx", "utf8").replace('import { useFetcher } from "react-router";', 'const { React, useFetcher } = globalThis.__codPreviewLibs;');
globalThis.__codPreviewLibs.CodMessagingToggle = (await import(asModule(toggleSource))).CodMessagingToggle;
const routeSource = readFileSync("app/routes/app.cod.tsx", "utf8");
const componentSource = `const { React, Form, Link, useFetcher, useLoaderData, useRevalidator, useEffect, CodMessagingToggle, styles } = globalThis.__codPreviewLibs;\nconst labels = { pending: "COD Pending", confirmed: "COD Confirmed", cancel_requested: "COD Cancel Requested", cancelled: "COD Cancelled" };\nconst outcomes = { no_answer: "No answer", confirmed: "Confirmed", declined: "Declined", callback: "Call back later" };\n${routeSource.slice(routeSource.indexOf("type Row"))}`;
const Component = (await import(asModule(componentSource))).default;
const previewPort = Number(process.argv[2] || 4317);
const date = new Date("2026-10-17T08:30:00Z");
const rows = [
  { id: "demo1", orderId: "101", orderNumber: "#1042", customerName: "Demo customer", phone: "919000000001", status: "pending", calls: [] },
  { id: "demo2", orderId: "102", orderNumber: "#1041", customerName: "Sample customer", phone: "919000000002", status: "pending", calls: [{ id: "call1", attempt: 1, outcome: "no_answer", createdAt: date }] },
  { id: "demo3", orderId: "103", orderNumber: "#1040", customerName: "Preview customer", phone: "919000000003", status: "confirmed", method: "WhatsApp demo", calls: [] },
  { id: "demo4", orderId: "104", orderNumber: "#1039", customerName: "Example customer", phone: "919000000004", status: "cancel_requested", calls: [{ id: "call2", attempt: 1, outcome: "declined", createdAt: date }] },
].map((row) => ({ ...row, products: "Sample outfit · Size M", address: "Demo delivery address", createdAt: date, reminderAt: date,
  messages: [{ id: row.id + "message", kind: "request", state: "accepted" }], events: [{ id: row.id + "event", createdAt: date, detail: "Sample order history" }] }));
const css = readFileSync("app/styles/cod.module.css", "utf8");
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${previewPort}`);
    const status = url.searchParams.get("status") || "";
    const task = url.searchParams.get("task") || "";
    const search = url.searchParams.get("q") || "";
    const orders = rows.filter((row) => (!status || row.status === status) && (!task || row.status === "pending") && (!search || `${row.orderNumber} ${row.customerName} ${row.phone}`.toLowerCase().includes(search.toLowerCase())));
    const routes = [{ id: "cod", path: "*", loader: () => ({ orders, total: orders.length, page: 1, search, status, task, summary: { pending: 2, confirmed: 1, cancel_requested: 1 }, callsDue: 2, enabled: true, shop: "preview.myshopify.com", now: date.getTime() + 3600000 }), Component }];
    const handler = createStaticHandler(routes);
    const context = await handler.query(new Request(url));
    const router = createStaticRouter(handler.dataRoutes, context);
    const html = renderToString(React.createElement(StaticRouterProvider, { router, context, hydrate: false }));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#f6f7f4;padding:28px;}s-page{display:block;max-width:1400px;margin:auto}${css}</style></head><body>${html}</body></html>`;
    writeFileSync(".cod-ui-preview.html", page);
    res.end(page);
  } catch (error) { res.statusCode = 500; res.end(String(error)); }
});
server.listen(previewPort, "127.0.0.1", () => console.log(`Local fixture preview: http://127.0.0.1:${previewPort}`));
