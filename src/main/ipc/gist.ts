import { ipcMain } from 'electron'
import { Octokit } from '@octokit/rest'
import { getGithubPat } from '../store/index'

function getOctokit(): Octokit {
  const pat = getGithubPat()
  if (!pat) throw new Error('GitHub PAT not configured')
  return new Octokit({ auth: pat })
}

export function registerGistHandlers(): void {
  /**
   * gist:save — create or update a gist with a `prompt.md` file.
   * If gistId is provided, updates the existing gist.
   * Returns the gist ID.
   */
  ipcMain.handle(
    'gist:save',
    async (_event, content: string, gistId?: string): Promise<string> => {
      const octokit = getOctokit()

      if (gistId) {
        // Update existing gist
        const response = await octokit.gists.update({
          gist_id: gistId,
          files: {
            'prompt.md': { content },
          },
        })
        return response.data.id!
      } else {
        // Create new gist
        const response = await octokit.gists.create({
          description: 'Conduit agent prompt',
          public: false,
          files: {
            'prompt.md': { content },
          },
        })
        return response.data.id!
      }
    }
  )

  /**
   * gist:load — fetch the content of `prompt.md` from a gist.
   * Returns the file content string.
   */
  ipcMain.handle('gist:load', async (_event, gistId: string): Promise<string> => {
    const octokit = getOctokit()

    const response = await octokit.gists.get({ gist_id: gistId })
    const file = response.data.files?.['prompt.md']

    if (!file) {
      throw new Error(`Gist ${gistId} does not contain a prompt.md file`)
    }

    return file.content ?? ''
  })
}
