import { describe, expect, it } from "vitest";
import { renderGateInstructions } from "../src/gate/features.ts";
import { loadPersona } from "../src/persona/loader.ts";
import { personaSettingsSchema, reactionChoices } from "../src/persona/schema.ts";
import { PERSONA } from "./fixtures.ts";

describe("reactions per platform", () => {
    it("sends QQ its emoji ID but keeps the name for the agent", () => {
        expect(reactionChoices(PERSONA, "qq")).toEqual([
            { label: "thumbs", id: "76" },
            { label: "👍", id: "128077" },
        ]);
    });

    it("uses the emoji itself elsewhere, including the simulator", () => {
        const expected = [
            { label: "👍", id: "👍" },
            { label: "😭", id: "😭" },
        ];
        expect(reactionChoices(PERSONA, "discord")).toEqual(expected);
        expect(reactionChoices(PERSONA, "cli")).toEqual(expected);
    });

    it("offers the model only the current platform's reactions", () => {
        expect(renderGateInstructions(PERSONA, "qq")).toContain("one reaction from thumbs 👍,");
        expect(renderGateInstructions(PERSONA, "discord")).toContain("one reaction from 👍 😭,");
    });

    it("rejects a QQ reaction that isn't a numeric ID", () => {
        expect(personaSettingsSchema.shape.reactions.safeParse({ qq: { thumbs: "👍" } }).success).toBe(false);
    });

    it("loads QQ reactions from the shipped persona", () => {
        expect(reactionChoices(loadPersona("personas/akane.md"), "qq")).toContainEqual({ label: "🤭", id: "264" });
    });
});
