import { describe, expect, it } from "vitest";
import { extractMentions, mentionQueryAtCaret, tokenizeMentions } from "./mentions";

const id = "11111111-2222-4333-8444-555555555555";
describe("mentions", () => {
  it("extracts unique mentions", () => {
    expect(extractMentions(`hi @[Sara](${id}) and again @[Sara](${id})`)).toEqual([{ userId: id, label: "Sara" }]);
  });
  it("tokenizes for rendering", () => {
    expect(tokenizeMentions(`a @[B](${id}) c`)).toEqual([{ type: "text", value: "a " }, { type: "mention", userId: id, label: "B" }, { type: "text", value: " c" }]);
  });
  it("finds the query at the caret", () => {
    expect(mentionQueryAtCaret("ping @sa", 8)).toEqual({ start: 5, query: "sa" });
    expect(mentionQueryAtCaret("email a@b", 9)).toBeNull();
  });
});
