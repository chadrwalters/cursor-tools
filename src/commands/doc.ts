import type { Command, CommandGenerator, CommandOptions, Config, Provider } from '../types';
import { defaultMaxTokens, loadConfig, loadEnv } from '../config';
import { pack } from 'repomix';
import { readFileSync } from 'node:fs';
import { FileError, NetworkError, ProviderError } from '../errors';
import type { ModelOptions, BaseModelProvider } from '../providers/base';
import { createProvider } from '../providers/base';
import { ModelNotFoundError } from '../errors';
import { ignorePatterns, includePatterns, outputOptions } from '../repomix/repomixConfig';
import { exhaustiveMatchGuard } from '../utils/exhaustiveMatchGuard';

interface DocCommandOptions extends CommandOptions {
  model: string;
  maxTokens?: number;
  fromGithub?: string;
  hint?: string;
  debug: boolean;
  provider?: 'gemini' | 'openai' | 'openrouter' | 'perplexity' | 'modelbox';
}

export class DocCommand implements Command {
  private config: Config;

  constructor() {
    loadEnv();
    this.config = loadConfig();
  }

  private parseGithubUrl(url: string): { username: string; reponame: string; branch?: string } {
    // Handle full HTTPS URL format
    if (url.startsWith('https://github.com/')) {
      const parts = url.replace('https://github.com/', '').split('/');
      const [username, repoWithBranch] = parts;
      const [reponame, branch] = repoWithBranch.split('@');
      return { username, reponame, branch };
    }

    // Handle username/reponame@branch format
    const [repoPath, branch] = url.split('@');
    const parts = repoPath.split('/');
    if (parts.length !== 2) {
      throw new ProviderError(
        'Invalid GitHub repository format. Use either https://github.com/username/reponame[@branch] or username/reponame[@branch]'
      );
    }

    return { username: parts[0], reponame: parts[1], branch };
  }

  private async getGithubRepoContext(
    repoPath: string
  ): Promise<{ text: string; tokenCount: number }> {
    const { username, reponame, branch } = this.parseGithubUrl(repoPath);
    const repoIdentifier = `${username}/${reponame}`;

    // First check repository size using GitHub API
    console.error('Checking repository size...');
    const sizeResponse = await fetch(`https://api.github.com/repos/${username}/${reponame}`);
    if (sizeResponse.ok) {
      const repoInfo = await sizeResponse.json();
      const sizeInMB = repoInfo.size / 1024; // size is in KB, convert to MB
      const maxSize = this.config.doc?.maxRepoSizeMB || 100; // Default to 100MB if not configured

      console.error(`Repository size: ${Math.round(sizeInMB)}MB (limit: ${maxSize}MB)`);

      // If repo is larger than the limit, throw an error
      if (sizeInMB > maxSize) {
        throw new ProviderError(
          `Repository ${repoIdentifier} is too large (${Math.round(sizeInMB)}MB) to process remotely.
The current size limit is ${maxSize}MB. You can:
1. Increase the limit by setting doc.maxRepoSizeMB in cursor-tools.config.json
2. Clone the repository locally and run cursor-tools doc without --fromGithub
3. The local processing will be more efficient and can handle larger codebases`
        );
      }
    } else {
      console.error('Could not determine repository size, proceeding anyway...');
    }

    console.error(
      'Fetching GitHub repository:',
      repoIdentifier,
      branch ? `(branch: ${branch})` : ''
    );

    const MAX_RETRIES = 3;
    const INITIAL_DELAY = 1000; // 1 second

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const formData = new FormData();
        formData.append(
          'url',
          `https://github.com/${repoIdentifier}` + (branch ? `/blob/${branch}` : '')
        );
        formData.append('format', 'xml');
        formData.append(
          'options',
          JSON.stringify({
            removeComments: false,
            removeEmptyLines: true,
            showLineNumbers: false,
            fileSummary: true,
            directoryStructure: true,
            outputParsable: false,
            includePatterns: includePatterns.join(','),
            ignorePatterns: ignorePatterns.join(','),
          })
        );

        const response = await fetch('https://api.repomix.com/api/pack', {
          headers: {
            accept: '*/*',
            'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
            priority: 'u=1, i',
            Referer: 'https://repomix.com/',
          },
          body: formData,
          method: 'POST',
        });

        if (response.ok) {
          const responseText = await response.text();
          try {
            // Try to parse as JSON to get metadata
            const responseJson = JSON.parse(responseText);
            const tokenCount = responseJson.metadata?.summary?.totalTokens;
            console.error(
              `Repository content token count (approximately): ${Math.round(tokenCount / 1000)}K tokens`
            );
            return { text: responseJson.content, tokenCount: tokenCount || 0 };
          } catch {
            // If parsing fails, return the text without token count
            console.error(
              'Could not parse token count from response, proceeding without token information'
            );
            return { text: responseText, tokenCount: 0 };
          }
        }

        const errorText = await response.text();

        // Check if error might be size-related
        if (
          errorText.toLowerCase().includes('timeout') ||
          errorText.toLowerCase().includes('too large')
        ) {
          throw new ProviderError(
            `Repository ${repoIdentifier} appears to be too large to process remotely.
Please:
1. Clone the repository locally
2. Run cursor-tools doc without --fromGithub
3. The local processing will be more efficient and can handle larger codebases`
          );
        }

        // If this is the last attempt, throw the error
        if (attempt === MAX_RETRIES) {
          throw new NetworkError(
            `Failed to fetch GitHub repository context: ${response.statusText}\n${errorText}`
          );
        }

        // For 5xx errors (server errors) and 429 (rate limit), retry
        // For other errors (like 4xx client errors), throw immediately
        if (!(response.status >= 500 || response.status === 429)) {
          throw new NetworkError(
            `Failed to fetch GitHub repository context: ${response.statusText}\n${errorText}`
          );
        }

        // Calculate delay with exponential backoff and jitter
        const delay = INITIAL_DELAY * 2 ** (attempt - 1) * (0.5 + Math.random());
        console.error(
          `Attempt ${attempt} failed. Retrying in ${Math.round(delay / 1000)} seconds...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error) {
        // If this is the last attempt, rethrow the error
        if (attempt === MAX_RETRIES) {
          throw error;
        }

        // For network errors (like timeouts), retry
        if (error instanceof Error) {
          const delay = INITIAL_DELAY * 2 ** (attempt - 1) * (0.5 + Math.random());
          console.error(`Attempt ${attempt} failed: ${error.message}`);
          console.error(`Retrying in ${Math.round(delay / 1000)} seconds...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // This should never be reached due to the throw in the last iteration
    throw new NetworkError('Failed to fetch GitHub repository context after all retries');
  }

  async *execute(query: string, options: DocCommandOptions): CommandGenerator {
    try {
      console.error('Generating repository documentation...\n');

      let repoContext: { text: string; tokenCount: number };

      if (options?.hint) {
        query += `\nHint: ${options.hint}\n`;
      }

      if (options?.fromGithub) {
        console.error(`Fetching repository context for ${options.fromGithub}...\n`);
        repoContext = await this.getGithubRepoContext(options.fromGithub);
      } else {
        console.error('Packing local repository using repomix...\n');
        const tempFile = '.repomix-output.txt';
        try {
          const packResult = await pack([process.cwd()], {
            output: {
              ...outputOptions,
              filePath: tempFile,
              includeEmptyDirectories: false,
            },
            include: includePatterns,
            ignore: {
              useGitignore: true,
              useDefaultPatterns: true,
              customPatterns: ignorePatterns,
            },
            security: {
              enableSecurityCheck: true,
            },
            tokenCount: {
              encoding: this.config.tokenCount?.encoding || 'o200k_base',
            },
            cwd: process.cwd(),
          });
          try {
            repoContext = {
              text: readFileSync(tempFile, 'utf-8'),
              tokenCount: packResult.totalTokens,
            };
          } catch (error) {
            throw new FileError('Failed to read repository context', error);
          }
        } catch (error) {
          throw new FileError('Failed to pack repository', error);
        }
      }

      const provider = createProvider(options?.provider || this.config.doc?.provider || 'gemini');
      const providerName = options?.provider || this.config.doc?.provider || 'gemini';

      // Add default model handling
      const getDefaultModel = (provider: Provider, tokenCount: number) => {
        console.log('getting default docs model for ', provider, tokenCount);
        if ((this.config as Record<string, any>)[provider]?.model) {
          return (this.config as Record<string, any>)[provider]?.model;
        }
        switch (provider) {
          case 'gemini':
            if (tokenCount < 800_000) {
              // 1M is the limit but token counts are very approximate so play it safe
              return 'gemini-2.0-flash-thinking-exp';
            }
            return 'gemini-2.0-pro-exp';
          case 'openai':
            return 'o3-mini';
          case 'openrouter':
            if (tokenCount < 150_000) {
              // 200k is the limit but token counts are very approximate so play it safe
              return 'anthropic/claude-3.7-sonnet-thinking'; // its 3.7 rather than 3-7 on openrouter
            }
            if (tokenCount < 800_000) {
              return 'google/gemini-2.0-flash-thinking-exp:free';
            }
            return 'google/gemini-2.0-pro-exp-02-05:free';
          case 'perplexity':
            return 'sonar-pro';
          case 'modelbox':
            if (tokenCount < 150_000) {
              // 200k is the limit but token counts are very approximate so play it safe
              return 'anthropic/claude-3-7-sonnet-thinking'; // updated to 3.7 on modelbox without -latest
            }
            return 'google/gemini-2.0-flash-thinking';
          case 'anthropic':
            return 'claude-3-7-sonnet-thinking-latest';
          default:
            throw exhaustiveMatchGuard(provider);
        }
      };

      // Add provider-specific token limits
      const getMaxTokens = (provider: Provider, requestedTokens?: number) => {
        const maxTokens =
          requestedTokens ||
          this.config.doc?.maxTokens ||
          (this.config as Record<string, any>)[provider]?.maxTokens ||
          defaultMaxTokens;

        return maxTokens;
      };

      const model =
        options?.model ||
        this.config.doc?.model ||
        getDefaultModel(providerName, repoContext.tokenCount);

      if (!model) {
        throw new ModelNotFoundError(providerName);
      }

      console.error(`Generating documentation using ${model}...\n`);
      let documentation: string;
      try {
        documentation = await generateDocumentation(query, provider, repoContext, {
          model,
          maxTokens: getMaxTokens(providerName, options?.maxTokens),
          debug: options?.debug,
        });
      } catch (error) {
        throw new ProviderError(
          error instanceof Error ? error.message : 'Unknown error during generation',
          error
        );
      }

      // Always yield documentation - quiet mode is handled at top level
      yield '\n--- Repository Documentation ---\n\n';
      yield documentation;
      yield '\n\n--- End of Documentation ---\n';

      console.error('Documentation generation completed!\n');
    } catch (error) {
      // console.error errors and then throw
      if (error instanceof Error) {
        console.error('Error in doc command:', error.message);
        if ('details' in error && options?.debug) {
          console.error(`Debug details: ${JSON.stringify(error.details, null, 2)}\n`);
          throw error;
        }
      } else {
        console.error('An unknown error occurred in doc command:', error);
        throw new Error('An unknown error occurred in doc command');
      }
    }
  }
}

// Documentation-specific provider interface
export interface DocModelProvider extends BaseModelProvider {
  generateDocumentation(
    repoContext: { text: string; tokenCount: number },
    options?: ModelOptions
  ): Promise<string>;
}

async function generateDocumentation(
  query: string,
  provider: BaseModelProvider,
  repoContext: { text: string; tokenCount: number },
  options: Omit<ModelOptions, 'systemPrompt'>
): Promise<string> {
  const userInstructions = query ? `User Instructions:\n${query}` : '';
  const prompt = `
Focus on:
1. Repository purpose and "what is it" summary
2. Quick start: How to install and use the basic core features of the project
3. Configuration options and how to configure the project for use (if applicable)
4. If a repository has multiple public packages perform all the following steps for every package:
5. Package summary & how to install / import it 
6. Detailed documentation of every public feature / API / interface
7. Dependencies and requirements
8. Advanced usage examples

${userInstructions}

Repository Context:
${repoContext.text}`;

  return provider.executePrompt(prompt, {
    ...options,
    tokenCount: repoContext.tokenCount,
    systemPrompt:
      'You are a documentation expert generating documentation for the provided codebase. You are generating documentation for AIs to use. Focus on communicating comprehensive information concisely. Public interfaces are more important than internal details. Generate comprehensive documentation that is clear, well-structured, and follows best practices. Always follow user instructions exactly.',
  });
}
