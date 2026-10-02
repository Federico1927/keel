import { getTranslations } from "next-intl/server";
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger } from "@hullwise/ui";

const CLIENTS = ["claude", "chatgpt", "cursor"] as const;
interface Step { title: string; body: string; verify?: boolean }

/**
 * How to connect Claude, ChatGPT and Cursor to the MCP server (#21). Steps that depend on the
 * vendor's interface carry the "To verify" badge, like the integration guides.
 */
export async function McpGuides({ serverUrl }: { serverUrl: string }) {
  const t = await getTranslations("mcp.guides");
  return (
    <div className="space-y-3" data-testid="mcp-guides">
      <p className="text-xs text-muted-foreground">{t("verify_legend")}</p>
      <Tabs defaultValue="claude">
        <TabsList>
          {CLIENTS.map((c) => (
            <TabsTrigger key={c} value={c}>{t(`${c}.name`)}</TabsTrigger>
          ))}
        </TabsList>
        {CLIENTS.map((c) => (
          <TabsContent key={c} value={c}>
            <ol className="space-y-3">
              {(t.raw(`${c}.steps`) as Step[]).map((s, i) => (
                <li key={i} className="rounded-lg border bg-card p-4" data-testid="mcp-guide-step">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{i + 1}</span>
                    <h4 className="font-medium">{s.title}</h4>
                    {s.verify && <Badge variant="warning">{t("verify_badge")}</Badge>}
                  </div>
                  <p className="mt-2 whitespace-pre-line break-words text-sm text-muted-foreground">{s.body.replaceAll("{serverUrl}", serverUrl)}</p>
                </li>
              ))}
            </ol>
          </TabsContent>
        ))}
      </Tabs>
      <p className="text-xs text-muted-foreground">{t("pat_note")}</p>
    </div>
  );
}
