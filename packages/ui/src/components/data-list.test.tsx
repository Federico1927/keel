import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataList } from "./data-list";

describe("DataList (#49)", () => {
  const html = renderToStaticMarkup(
    <DataList
      rows={[{ id: "1", name: "#1001", total: "€10", channel: "web" }]}
      rowKey={(r) => r.id}
      rowProps={() => ({ "data-testid": "row" })}
      columns={[
        { key: "name", header: "Order", mobile: "title", cell: (r) => <a href={`/o/${r.id}`}>{r.name}</a> },
        { key: "channel", header: "Channel", priority: 2, cell: (r) => r.channel },
        { key: "total", header: "Total", mobile: "badge", align: "right", cell: (r) => r.total },
        { key: "secret", header: "Internal", mobile: "detail", cell: () => "x" },
      ]}
      footer={{ name: "Totals", total: "€10" }}
    />,
  );

  it("is one table: rows and cells stay table rows for desktop and assistive tech", () => {
    expect(html).toContain("<table");
    expect((html.match(/<tr[ >]/g) ?? []).length).toBe(3);
    expect(html).toContain('data-testid="row"');
  });

  it("gives every column its phone role and table priority, without hiding data by default", () => {
    expect(html).toMatch(/<td class="[^"]*max-md:order-1[^"]*"[^>]*><a href="\/o\/1">/);
    expect(html).toContain('data-label="Channel"');
    expect(html).toContain("md:max-lg:hidden");
    expect((html.match(/max-md:hidden/g) ?? []).length).toBeGreaterThanOrEqual(2); // the detail column and the empty footer cells
    expect(html).not.toMatch(/hidden (sm|md|lg):table-cell/);
  });
});
