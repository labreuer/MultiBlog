-- docs/MCP.md §21, "Which clients": ChatGPT's connections, whether through its
-- pinned identity or a client registered by hand as its fallback.
ALTER TYPE "api_token_client" ADD VALUE 'CHATGPT' BEFORE 'OTHER';
