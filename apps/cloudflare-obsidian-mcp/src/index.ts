export default {
  fetch(): Response {
    return Response.json(
      { error: 'not_implemented', message: 'The Obsidian MCP endpoint is not implemented yet.' },
      { status: 501 }
    );
  },
} satisfies ExportedHandler<Env>;
