import fs from './fs'
import nodePath from 'path'
import Dat from 'dat-node'
import logger from './logger'
import pipeStreams from './pipe-streams'
import {formatSize} from './format-size'
import storage from './storage'
import prompt from './prompt'

export default class DatCp {

  constructor(program, options = {}) {
    this.program = program
    this.options = options
    this.files = 0
    this.totalSize = 0
  }

  connect() {
    return new Promise((resolve) => {
      logger.debug('Creating dat archive.')

      Dat(storage('.'), {...this.options}, async (err, dat) => {
        if (err) {
          logger.error(err.toString())
          logger.error(`Failed to initialize dat archive.`)
          process.exit(1)
        }

        this.dat = dat
        dat.trackStats()

        await this.joinNetwork()
        resolve()
      })
    })
  }

  joinNetwork() {
    return new Promise((resolve, reject) => {
      logger.debug('Connecting to dat network.')

      this.dat.joinNetwork()

      if (!this.options.key) {
        return resolve()
      }

      const abort = setTimeout(() => {
        logger.error('Failed to connect to any peers.')
        process.exit(1)
      }, 15000)

      const connect = setInterval(() => {
        for (const conn of this.dat.network.connections) {
          if (conn.writable) {
            logger.debug('Connected to upload peer.')
            clearInterval(connect)
            clearTimeout(abort)
            resolve()
          }
        }
      }, 300)
    })
  }

  async upload(paths) {
    await this.ensurePathsValid(paths)

    if (this.program.dryRun) {
      this.printTotal()
      process.exit(0)
    }

    logger.debug('Creating metadata for files:')
    for (const path of paths) {
      await this.uploadPath(path, '')
    }

    this.printTotal()
  }

  async ensurePathsValid(paths) {
    this.count = 0

    for (const path of paths) {
      await this.ensurePathValid(path)
    }

    if (!this.files) {
      logger.error(`No files to copy.`)
      process.exit(1)
    }
  }

  async ensurePathValid(path) {
    let stats

    try {
      stats = await fs.lstat(path)
    } catch (err) {
      logger.error(`${path}: No such file or directory.`)
      process.exit(1)
    }

    if (stats.isFile()) {
      this.countPath(path, stats, this.program.dryRun)
      return
    }

    if (stats.isDirectory()) {
      return await this.ensureDirValid(path, stats)
    }

    logger.warn(`${path}: Not a file or directory (not copied).`)
    return
  }

  async ensureDirValid(path, stats) {
    if (!this.program.recursive) {
      logger.warn(`${path}: Is a directory (not copied).`)
      return
    }

    if (path[path.length - 1] !== '/') {
      this.countPath(path, stats, this.program.dryRun)
    }

    const dirPaths = await fs.readdir(path)

    for (const dirPath of dirPaths) {
      await this.ensurePathValid(nodePath.join(path, dirPath))
    }
  }

  async uploadPath(path, datPath) {
    const stats = await fs.lstat(path)

    if (stats.isFile()) {
      await this.uploadFile(path, datPath)
    } else if (stats.isDirectory()) {
      await this.uploadDir(path, datPath)
    }
  }

  async uploadFile(path, datPath) {
    datPath = nodePath.join(datPath, nodePath.parse(path).base)
    const stats = await fs.lstat(path)
    const filesize = stats.size || 1

    const readStream = fs.createReadStream(path)
    const writeStream = this.dat.archive.createWriteStream(datPath, {path})

    await pipeStreams(readStream, writeStream, filesize, datPath)
  }

  async uploadDir(path, datPath) {
    if (!this.program.recursive) {
      return
    }

    // If a source dir ends with `/`, copy its contents, not the dir itself
    if (path[path.length - 1] !== '/') {
      datPath = nodePath.join(datPath, nodePath.parse(path).base)
      await this.mkdir(datPath)
    }

    const dirPaths = await fs.readdir(path)

    for (const dirPath of dirPaths) {
      await this.uploadPath(nodePath.join(path, dirPath), datPath)
    }
  }

  mkdir(path) {
    return new Promise((resolve) => {
      this.dat.archive.mkdir(path, (err) => {
        if (err) {
          logger.error(err.toString())
          logger.error(`${path}: Failed to create directory in dat archive.`)
          process.exit(1)
        }
        resolve()
      })
    })
  }

  download(listOnly=false) {
    return new Promise((resolve) => {
      const abort = setTimeout(() => {
        logger.error('Failed to download metadata from peer.')
        process.exit(1)
      }, 15000)

      const readRoot = setInterval(async () => {
        const paths = await this.readdir('/')

        if (paths.length !== 0) {
          clearInterval(readRoot)
          clearTimeout(abort)

          for (const path of paths) {
            await this.downloadPath(path, listOnly)
          }

          if (
            this.program.dryRun ||
            (!listOnly && this.files > 30) ||
            this.files === 0
          ) {
            this.printTotal()
          }
          resolve()
        }
      }, 300)
    })
  }

  async downloadPath(path, listOnly) {
    const stats = await this.stat(path)

    if (stats.isDirectory()) {
      await this.downloadDir(path, stats, listOnly)
    } else {
      await this.downloadFile(path, stats, listOnly)
    }
  }

  async downloadFile(path, stats, listOnly) {
    // If the file exists and is the same size, assume that it hasn't changed
    // and skip it.
    try {
      const fsStats = await fs.lstat(path)
      if (stats.size === fsStats.size) {
        logger.warn(`${path}: File is identical (not copied).`)
        return
      }
    } catch (err) {
      // File doesn't exist, do nothing.
    }

    this.countPath(path, stats, listOnly)

    if (listOnly) {
      return
    }

    const readStream = this.dat.archive.createReadStream(path)
    const writeStream = fs.createWriteStream(path)
    const filesize = stats.size || 1

    await pipeStreams(readStream, writeStream, filesize, path)
  }

  async downloadDir(path, stats, listOnly) {
    if (!listOnly) {
      // lstat will throw an error if a path does not exist, so rely on that to
      // know that the dir does not already exist. If the path exists and is not
      // a directory, error.
      try {
        const stats = await fs.lstat(path)
        if (!stats.isDirectory()) {
          logger.error(`${path}: Not a directory.`)
          process.exit(1)
        }
      } catch (err) {
        await fs.mkdir(path)
      }
    }

    this.countPath(path, stats, listOnly)

    const dirPaths = await this.readdir(path)

    for (const dirPath of dirPaths) {
      await this.downloadPath(nodePath.join(path, dirPath), listOnly)
    }
  }

  countPath(path, stats, listPath) {
    if (path === '.') {
      return
    }

    this.files += 1
    this.totalSize += stats.size

    if (!listPath) {
      return
    }

    if (stats.isFile()) {
      logger.info(`${formatSize(stats.size).padEnd(8)} ${path}`)
    } else if (stats.isDirectory()) {
      logger.info(`${'-'.padEnd(8)} ${path}`)
    }
  }

  printTotal() {
    logger.info(`\nTotal: ${this.files} files (${formatSize(this.totalSize)})`)
  }

  resetCounts() {
    this.files = 0
    this.totalSize = 0
  }

  async downloadPrompt() {
    const answer = await prompt(
      `\nDownload ${this.files} files (${formatSize(this.totalSize)})? [Y/n] `
    )

    const proceed = ['yes', 'y', ''].includes(answer.trim().toLowerCase())

    if (proceed) {
      logger.info()
    }

    return proceed
  }

  readdir(path) {
    return new Promise((resolve, reject) => {
      this.dat.archive.readdir(path, async (err, paths) => {
        if (err) {
          logger.error(err.toString())
          logger.error(`${path}: Failed to read from dat archive.`)
          process.exit(1)
        }
        resolve(paths)
      })
    })
  }

  stat(path) {
    return new Promise((resolve, reject) => {
      this.dat.archive.stat(path, (err, stats) => {
        if (err) {
          logger.error(err.toString())
          logger.error(`${path}: Failed to get stats from dat archive.`)
          process.exit(1)
        }
        resolve(stats)
      })
    })
  }

}
