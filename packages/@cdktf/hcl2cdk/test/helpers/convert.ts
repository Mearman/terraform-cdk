// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { convert } from "../../lib/index";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import execa from "execa";
import {
  LANGUAGES,
  TerraformModuleConstraint,
  TerraformProviderConstraint,
} from "@cdktf/commons";
import {
  ConstructsMakerProviderTarget,
  readSchema,
} from "@cdktf/provider-generator";

import deepmerge from "deepmerge";

// Polyfill for older TS versions
type Awaited<T> = T extends PromiseLike<infer U> ? U : T;
type SchemaPromise = ReturnType<typeof readSchema>;
export enum Synth {
  yes_all_languages, // Synth and snapshot all languages
  yes,
  no_missing_map_access, // See https://github.com/hashicorp/terraform-cdk/issues/2670
  never, // Some examples are built so that they will never synth but test a specific generation edge case
}

type PathToCopy = string;
type ProviderFqn = string;
enum ProviderType {
  provider,
  module,
}

type ProviderDefinition = {
  fqn: ProviderFqn;
  type: ProviderType;
  path: PathToCopy;
};

type SchemaFilter = {
  resources?: string[];
  dataSources?: string[];
};

const cdktfBin = path.join(__dirname, "../../../../cdktf-cli/bundle/bin/cdktf");
const cdktfDist = path.join(__dirname, "../../../../../dist");

export const binding = {
  aws: {
    fqn: "hashicorp/aws@=4.57.0",
    type: ProviderType.provider,
    path: "providers/aws",
  },
  docker: {
    fqn: "kreuzwerker/docker@=3.0.1",
    type: ProviderType.provider,
    path: "providers/docker",
  },
  null: {
    fqn: "hashicorp/null@=3.2.1",
    type: ProviderType.provider,
    path: "providers/null",
  },
  google: {
    fqn: "hashicorp/google@=4.55.0",
    type: ProviderType.provider,
    path: "providers/google",
  },
  azuread: {
    fqn: "hashicorp/azuread@=2.36.0",
    type: ProviderType.provider,
    path: "providers/azuread",
  },
  local: {
    fqn: "hashicorp/local@=2.3.0",
    type: ProviderType.provider,
    path: "providers/local",
  },
  auth0: {
    fqn: "alexkappa/auth0@=0.26.2",
    type: ProviderType.provider,
    path: "providers/auth0",
  },
  datadog: {
    fqn: "DataDog/datadog@=3.21.0",
    type: ProviderType.provider,
    path: "providers/datadog",
  },
  kubernetes: {
    fqn: "hashicorp/kubernetes@=2.18.0",
    type: ProviderType.provider,
    path: "providers/kubernetes",
  },
  awsVpc: {
    fqn: "terraform-aws-modules/vpc/aws@=3.19.0",
    type: ProviderType.module,
    path: "modules/terraform-aws-modules/aws",
  },
};

type AbsolutePath = string;
const providerBindingCache: Record<
  ProviderFqn,
  Promise<AbsolutePath> | undefined
> = {};
const providerSchemaCache: Record<ProviderFqn, SchemaPromise | undefined> = {};

async function generateBindings(
  binding: ProviderDefinition
): Promise<AbsolutePath> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cdktf-provider-"));
  await fs.writeFile(
    path.resolve(tempDir, "cdktf.json"),
    JSON.stringify({
      language: "typescript",
      app: "npx ts-node main.ts",
      terraformProviders:
        binding.type === ProviderType.provider ? [binding.fqn] : [],
      terraformModules:
        binding.type === ProviderType.module ? [binding.fqn] : [],
    })
  );
  await execa(cdktfBin, ["get"], { cwd: tempDir });

  return path.resolve(tempDir, ".gen", binding.path);
}

async function copyBindingsForProvider(
  binding: ProviderDefinition,
  targetDirectory: AbsolutePath
) {
  const absoluteBindingPathPromise = providerBindingCache[binding.fqn]
    ? providerBindingCache[binding.fqn]
    : generateBindings(binding);

  providerBindingCache[binding.fqn] = absoluteBindingPathPromise;

  const target = path.resolve(targetDirectory, ".gen", binding.path);
  await fs.mkdirp(target);
  const absolutePath = await absoluteBindingPathPromise;

  await fs.copy(absolutePath!, target);
}

// Prepare for tests / warm up cache
const prepareBaseProject = (language: string) =>
  new Promise<string>(async (resolve) => {
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cdktf-convert-base-")
    );
    await execa(
      cdktfBin,
      [
        "init",
        "--local",
        `--dist=${cdktfDist}`,
        "--project-name='hello'",
        "--project-description='world'",
        `--template=${language}`,
        "--enable-crash-reporting=false",
      ],
      {
        cwd: projectDir,
      }
    );

    resolve(projectDir);
  });

const baseProjectPromisePerLanguage = ["typescript", "python"].reduce(
  (acc, language) => ({ ...acc, [language]: prepareBaseProject(language) }),
  {} as Record<string, Promise<string>>
);

const fileEndings: Record<string, string> = {
  typescript: ".ts",
  python: ".py",
};

const getFileContent: Record<
  string,
  (code: string, stackName: string) => string
> = {
  typescript: (code, stackName) => `
${code}
const app = new cdktf.App();
new MyConvertedCode(app, "${stackName}");
app.synth();`,
  python: (code, stackName) => `
${code}

app = App()
MyConvertedCode(app, "${stackName}")
app.synth()
`,
};

const getAppCommand: Record<string, (stackName: string) => string> = {
  typescript: (stackName) => `npx ts-node ${stackName}.ts`,
  python: (stackName) => `pipenv run python ${stackName}.py`,
};

async function synthForLanguage(
  language: string,
  name: string,
  convertedCode: string,
  providers: ProviderDefinition[] = []
) {
  const stackName = name.replace(/\s/g, "-");
  const projectDirPromise = getProjectDirectory("typescript", providers);
  const projectDir = await projectDirPromise;

  // Have a before all somewhere above bootstrap a TS project
  // __dirname should be replaceed by the bootstrapped directory
  const pathToThisProjectsFile = path.join(
    projectDir,
    stackName + fileEndings[language]
  );
  const fileContent = getFileContent[language](convertedCode, stackName);

  fs.writeFileSync(pathToThisProjectsFile, fileContent, "utf8");

  const stdout = execSync(
    `${cdktfBin} synth -a '${getAppCommand[language](
      stackName
    )}' -o ./${stackName}-output`,
    { cwd: projectDir }
  );
  expect(stdout.toString()).toEqual(
    expect.stringContaining(`Generated Terraform code for the stacks`)
  );
}

// getProviderSchema(Object.values(binding));

async function getProjectDirectory(
  language: string,
  providers: ProviderDefinition[]
) {
  const baseProjectPromise = baseProjectPromisePerLanguage[language];
  if (!baseProjectPromise) {
    throw new Error(
      `Unsupported language used to synthesize code: ${language}`
    );
  }
  const baseDir = await baseProjectPromise;
  const projectDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cdktf-convert-test-")
  );

  await Promise.all([
    fs.copy(baseDir, projectDir),
    ...providers.map((provider) =>
      copyBindingsForProvider(provider, projectDir)
    ),
  ]);

  // We only copy the TS bindings, but we need to run cdktf get for the language specific ones
  if (language !== "typescript") {
    await fs.writeFile(
      path.resolve(projectDir, "cdktf.json"),
      JSON.stringify(
        {
          language,
          app: "echo 'app command should be overwritten'",
          terraformProviders: providers
            .filter((binding) => binding.type === ProviderType.provider)
            .map((binding) => binding.fqn),
          terraformModules: providers
            .filter((binding) => binding.type === ProviderType.module)
            .map((binding) => binding.fqn),
        },
        null,
        2
      )
    );
    await execa(cdktfBin, ["get"], { cwd: projectDir });
  }

  return projectDir;
}

async function getProviderSchema(providers: ProviderDefinition[]) {
  const providerSchemaPromises = providers.map((provider) => {
    if (providerSchemaCache[provider.fqn]) {
      return providerSchemaCache[provider.fqn];
    }

    const providerSchema = readSchema([
      ConstructsMakerProviderTarget.from(
        ProviderType.provider === provider.type
          ? new TerraformProviderConstraint(provider.fqn)
          : new TerraformModuleConstraint(provider.fqn),
        LANGUAGES[0]
      ),
    ]);

    providerSchemaCache[provider.fqn] = providerSchema;

    return providerSchema;
  });

  const subSchemas = await Promise.all(providerSchemaPromises);

  return deepmerge.all([
    { providerSchema: { provider_schemas: {} }, moduleSchema: {} },
    ...(subSchemas.filter((s) => s !== undefined) as Awaited<SchemaPromise>[]),
  ]) as any;
}

function filterSchema(
  providerSchema: any,
  schemaFilter: SchemaFilter | undefined
) {
  if (!schemaFilter) return providerSchema;

  const { resources, dataSources } = schemaFilter;

  const providerSchemaKey = Object.keys(providerSchema.provider_schemas)[0];
  const actualSchema = providerSchema.provider_schemas[providerSchemaKey];

  let filteredDataSourceSchemas = {};
  let filteredResourceSchemas = {};

  if (resources && resources.length > 0) {
    filteredResourceSchemas = Object.fromEntries(
      Object.entries(actualSchema.resource_schemas).filter(([resourceName]) =>
        resources?.includes(resourceName)
      )
    );
  }

  if (dataSources && dataSources.length > 0) {
    filteredDataSourceSchemas = Object.fromEntries(
      Object.entries(actualSchema.data_source_schemas).filter(
        ([dataSourceName]) => dataSources?.includes(dataSourceName)
      )
    );
  }

  return {
    provider_schemas: {
      [providerSchemaKey]: {
        provider: providerSchema.provider_schemas[providerSchemaKey].provider,
        resource_schemas: filteredResourceSchemas,
        data_source_schemas: filteredDataSourceSchemas,
      },
    },
  };
}

const createTestCase =
  (opts: { skip?: true; only?: true }) =>
  (
    name: string,
    hcl: string,
    providers: ProviderDefinition[],
    shouldSynth: Synth,
    schemaFilter?: SchemaFilter
  ) => {
    if (opts.skip) {
      describe.skip(name, () => {});
      return;
    }

    async function runConvert(language: string) {
      let { providerSchema } = await getProviderSchema(providers);
      if (schemaFilter) {
        // TODO: Re-enable once we can trick Terraform CLI Checksums
        providerSchema = filterSchema(providerSchema, undefined);
      }
      return await convert(hcl, {
        language: language as any,
        providerSchema,
        codeContainer: "cdktf.TerraformStack",
      });
    }

    const testBody = () => {
      describe("typescript", () => {
        let convertResult: any;
        beforeAll(async () => {
          convertResult = await runConvert("typescript");
        }, 500_000);

        it("snapshot", async () => {
          expect(convertResult.all).toMatchSnapshot();
        }, 500_000);

        if (
          shouldSynth === Synth.yes ||
          shouldSynth === Synth.yes_all_languages
        ) {
          it("synth", async () => {
            await synthForLanguage(
              "typescript",
              name,
              convertResult.all,
              providers
            );
          }, 500_000);
        }
      });

      if (shouldSynth === Synth.yes_all_languages) {
        describe.each(["python", "csharp", "java", "go"])("%s", (language) => {
          let projectDir = "";
          let convertResult: any;

          beforeAll(async () => {
            projectDir = await getProjectDirectory("typescript", providers);

            process.chdir(projectDir); // JSII rosetta needs to be run in the project directory with bindings included
          }, 500_000);

          it("snapshot", async () => {
            convertResult = await runConvert(language);
            expect(convertResult.all).toMatchSnapshot();
          }, 500_000);

          if (language === "python") {
            // Skipped becaue import ...gen.providers.aws as aws is an invalid syntax
            it("synth", async () => {
              await synthForLanguage(
                "python",
                name,
                convertResult.all,
                providers
              );
            }, 500_000);
          }
        });
      }
    };

    if (opts.only) {
      describe.only(name, testBody);
      return;
    }
    describe(name, testBody);
  };

export const testCase = {
  test: createTestCase({}),
  skip: createTestCase({ skip: true }),
  only: createTestCase({ only: true }),
};
