import { createRoot } from "react-dom/client";
import { AppMcpChat } from "@app-mcp/host";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <main>
    <h1>Your MCP, inside your app</h1>
    <p>Use your existing tools, components and workflows.</p>
    <AppMcpChat
      threadId="example"
      endpoint="/api/chat"
      sandboxUrl="http://127.0.0.1:4192/sandbox"
      hostContext={{ theme: "light" }}
      callTool={async (name, args) => {
        const response = await fetch("/api/widget", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, args }),
        });
        if (!response.ok) throw new Error("Widget request failed");
        return response.json();
      }}
    />
  </main>,
);
