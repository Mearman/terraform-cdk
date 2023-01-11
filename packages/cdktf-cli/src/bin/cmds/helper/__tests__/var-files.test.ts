import { sanitizeVarFiles } from "../var-files";
import * as path from "path";
describe("sanitizeVarFiles", () => {
  it("adds files in right order", () => {
    const cwd = path.join(__dirname, "fixtures");
    expect(
      sanitizeVarFiles(["foo.tfvars"], cwd).map((p) =>
        p.replace(cwd, "<rootDir>")
      )
    ).toMatchInlineSnapshot(`
      Array [
        "<rootDir>/terraform.tfvars",
        "<rootDir>/hey-there.auto.tfvars",
        "<rootDir>/foo.tfvars",
      ]
    `);
  });
});
