/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import * as core from '@actions/core'
import * as glob from '@actions/glob'
import { parseInputFiles, readAsset, uploadUrl } from './util'
import { GitHub } from '@actions/github/lib/utils'
import { Octokit } from '@octokit/core'
import { context } from '@actions/github'
import fetch from 'node-fetch'
import { readFileSync } from 'fs'

async function run(): Promise<void> {
  try {
    const { GITHUB_SHA } = process.env
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.INPUT_TOKEN
    const github = new GitHub({ auth: GITHUB_TOKEN })
    const { owner, repo } = context.repo

    const tagName: string = core.getInput('tag_name')
    let isDraft: boolean = core.getInput('draft') === 'true'
    const isPrerelease: boolean = core.getInput('prerelease') === 'true'

    if (isDraft) {
      core.warning('Deprecated, draft must be turned off for nightly build.')
      isDraft = false
    }

    let name = core.getInput('name')
    if (name.includes('$$')) {
      const today = new Date()
      const nightlyName = today.toISOString().split('T')[0].replaceAll('-', '')

      name = name.replace('$$', nightlyName)
    }

    const body = releaseBody()

    const filesPatterns = parseInputFiles(core.getInput('files'))
    const globber = await glob.create(filesPatterns.join('\n'))
    const files = await globber.glob()

    // get release from tag
    let rel
    try {
      rel = await github.rest.repos.getReleaseByTag({
        owner,
        repo,
        tag: tagName
      })
      // draft it
      await github.rest.repos.updateRelease({
        owner,
        repo,
        release_id: rel.data.id,
        draft: true
      })
    } catch (e) {
      // release 404
    }
    if (!rel) {
      const ret = await github.rest.repos.createRelease({
        owner,
        repo,
        tag_name: tagName,
        target_commitish: GITHUB_SHA,
        name: 'Nightly Release',
        draft: true
      })
      rel = await github.rest.repos.getRelease({
        owner,
        repo,
        release_id: ret.data.id
      })
    }
    core.info(`🍻 Release found ${rel.data.name} by ${rel.data.author.login}`)

    // delete release assets
    const { data: release } = rel
    if (release.assets.length > 0) {
      await core.group(
        `Delete ${release.assets.length} old release assets`,
        async () => {
          for (const asset of release.assets) {
            core.info(`❌ deleting ${asset.name}`)
            try {
              await github.rest.repos.deleteReleaseAsset({
                owner,
                repo,
                asset_id: asset.id
              })
            } catch (e) {
              const error = e as any
              core.warning(
                `failed to delete ${asset.name} ${error.name} ${error.status}`
              )
              throw e
            }
          }
          core.info(`🗑️ deleted ${release.assets.length} assets`)
        }
      )
    }

    // update or create ref
    let ref
    try {
      ref = await github.rest.git.getRef({
        owner,
        repo,
        ref: `tags/${tagName}`
      })
    } catch (e) {
      // Reference does not exist
    }
    if (!ref) {
      core.info(`🏷️ set ref tags/${tagName} to ${GITHUB_SHA}`)
      await github.rest.git.createRef({
        owner,
        repo,
        ref: `refs/tags/${tagName}`,
        sha: GITHUB_SHA!
      })
    } else if (ref.data.object.sha !== GITHUB_SHA) {
      core.info(
        `🏷️ update ref tags/${tagName} from ${ref.data.object.sha} to ${GITHUB_SHA}`
      )
      await github.rest.git.updateRef({
        owner,
        repo,
        ref: `tags/${tagName}`,
        sha: GITHUB_SHA!
      })
    } else {
      core.info(`🏷️ ref tags/${tagName} is ${GITHUB_SHA}, keep it`)
    }

    core.info(`🎬 update release info: ${name}`)
    const ret = await github.rest.repos.updateRelease({
      owner,
      repo,
      release_id: release.id,
      name,
      body,
      draft: isDraft,
      prerelease: isPrerelease
    })

    if (files.length === 0) {
      core.warning(`🤔 ${files} does not include valid file`)
    } else {
      await core.group(
        `Upload ${files.length} new release assets`,
        async () => {
          const assets = await Promise.all(
            files.map(async path => {
              const json = await upload(
                github,
                owner,
                repo,
                uploadUrl(ret.data.upload_url),
                path
              )
              delete json.uploader
              return json
            })
          )
          core.setOutput('assets', assets)
        }
      )
    }
    core.info(`🎉 Release ready at ${ret.data.html_url}`)

    core.setOutput('url', ret.data.html_url)
    core.setOutput('id', ret.data.id.toString())
    core.setOutput('upload_url', ret.data.upload_url)
  } catch (error) {
    core.error(`💥 error: ${error}`)
    if (error instanceof Error) core.setFailed(error.message)
  }
}

const upload = async (
  github: Octokit,
  owner: string,
  repo: string,
  url: string,
  path: string
): Promise<any> => {
  const { name, size, mime, data: body } = readAsset(path)
  core.info(`⬆️ Uploading ${name}...`)
  const AUTH_TOKEN = process.env.GITHUB_TOKEN || process.env.INPUT_TOKEN
  const endpoint = new URL(url)
  endpoint.searchParams.append('name', name)
  const resp = await fetch(endpoint.toString(), {
    headers: {
      'content-length': `${size}`,
      'content-type': mime,
      authorization: `token ${AUTH_TOKEN}`
    },
    method: 'POST',
    body
  })
  const json = (await resp.json()) as any
  if (resp.status !== 201) {
    throw new Error(
      `Failed to upload release asset ${name}. received status code
      ${resp.status}\n${json.message}\n${JSON.stringify(json.errors)}`
    )
  }
  return json
}

const releaseBody = (): string => {
  const bodyPath = core.getInput('body_path')
  return (
    (bodyPath && readFileSync(bodyPath).toString('utf8')) ||
    core.getInput('body') ||
    'No release body provided.'
  )
}

run()
