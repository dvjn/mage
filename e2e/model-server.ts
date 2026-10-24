// A stand-in OpenAI-compatible server for the browser journeys, as people run Ollama or vLLM: it
// lists two models, one Meta's and one no one can tell the maker of, to anyone.

import { createServer } from "node:http";

const port = Number(process.env.PORT ?? "4792");

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          { id: "llama-3.3-70b-instruct", object: "model", owned_by: "meta" },
          { id: "lab-tune-7b", object: "model", owned_by: "lab" },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
}).listen(port);
