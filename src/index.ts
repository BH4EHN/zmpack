import FS from 'fs';
import OS from 'os';
import Path from 'path';
import Util from 'util';
import ChildProcess from 'child_process';
import Log4js from 'log4js';
import Archiver from 'archiver';

const fsReadFile = Util.promisify(FS.readFile);
const fsStat = Util.promisify(FS.stat);
const fsRmdir = Util.promisify(FS.rmdir);
const fsUnlink = Util.promisify(FS.unlink);
const fsCopyFile = Util.promisify(FS.copyFile);
const fsMkdir = Util.promisify(FS.mkdir);
const fsReaddir = Util.promisify(FS.readdir);
const childProcessExec = Util.promisify(ChildProcess.exec);

const configFileName = 'zmpack.json';
const workingPath = process.cwd();

Log4js.configure(Path.join(__dirname, '../log4js.config.json'));
const mainLogger = Log4js.getLogger('main');
const actionLogger = Log4js.getLogger('action');
const copyLogger = Log4js.getLogger('copy');
const archiverLogger = Log4js.getLogger('archiver');

main()
    .catch((err) => {
        mainLogger.error(err);
    });

async function main(): Promise<void> {
    const config = await readConfig(configFileName);
    const targetFilePath = await processConfig(config);
    mainLogger.info(`packed on "${targetFilePath}"`);
}

async function readConfig(configName: string): Promise<Configuration> {
    const configFilePath = Path.join(workingPath, configName);
    const isConfigExists = await fsExist(configFilePath);
    if (!isConfigExists) {
        throw new Error('"zmpack.json" is required');
    }
    const configJson = await fsReadFile(configFilePath, { encoding: 'utf8' });
    const config = <Configuration>JSON.parse(configJson);
    return config;
}

async function processConfig(config: Configuration): Promise<string> {
    mainLogger.info('run copyBefore');
    await processActions('copyBefore', workingPath, config.copyBefore);
    const tempPath = OS.tmpdir();
    const timeNow = new Date();
    const timeText =
        timeNow.getFullYear().toString() +
        timeNow.getMonth().toString().padStart(2, '0') +
        timeNow.getDay().toString().padStart(2, '0') +
        timeNow.getHours().toString().padStart(2, '0') +
        timeNow.getMinutes().toString().padStart(2, '0') +
        timeNow.getSeconds().toString().padStart(2, '0');
    const tempDirName = `${config.name}-${timeText}`;
    const tempDirPath = Path.join(tempPath, tempDirName);
    mainLogger.info('run copy');
    await processCopy(workingPath, tempDirPath, config.files);
    mainLogger.info('run copyAfter');
    await processActions('copyAfter', workingPath, config.copyAfter);
    mainLogger.info('run packBefore');
    await processActions('copyBefore', tempDirPath, config.packBefore);
    const targetFileName = `${config.name}.${timeText}.zip`;
    const targetFilePath = Path.join(config.targetPath, targetFileName);
    mainLogger.info('run pack');
    await processPack(tempDirPath, targetFilePath);
    mainLogger.info('run packAfter');
    await processActions('copyBefore', tempDirPath, config.packAfter);
    process.chdir(workingPath);
    await rmDirectoryRecursive(tempDirPath);
    return targetFilePath;
}

async function processActions(stageName: string, workingPath: string, actions: string[][]): Promise<void> {
    actionLogger.trace(`chdir to "${workingPath}"`);
    process.chdir(workingPath);
    for (const action of actions) {
        const actionType = action[0];
        switch (actionType) {
            case 'delete': {
                const itemName = action[1];
                actionLogger.info(`DELETE "${itemName}"`);
                const itemPath = Path.join(workingPath, itemName);
                if (await fsExist(itemPath)) {
                    const stat = await fsStat(itemPath);
                    if (stat.isFile()) {
                        await fsUnlink(itemPath);
                    } else if (stat.isDirectory()) {
                        await rmDirectoryRecursive(itemPath);
                    } else {
                        actionLogger.warn(`path "${itemPath}" is not either file or directory`);
                    }
                }
                break;
            }
            case 'command': {
                const commandLine = action[1];
                actionLogger.info(`COMMAND "${commandLine}"`);
                const execResult = await childProcessExec(commandLine, { cwd: workingPath } );
                console.log(execResult.stdout);
                console.log(execResult.stderr);
                break;
            }
            default: {
                mainLogger.warn(`unknown action "${actionType}" in ${stageName}`);
            }
        }
    }
}

async function rmDirectoryRecursive(dirPath: string): Promise<void> {
    const files = await fsReaddir(dirPath);
    for (const itemName of files) {
        const itemPath = Path.join(dirPath, itemName);
        const itemStat = await fsStat(itemPath);
        if (itemStat.isFile()) {
            await fsUnlink(itemPath);
        } else if (itemStat.isDirectory()) {
            await rmDirectoryRecursive(itemPath);
        } else {
            throw new Error(`cannot remove "${itemPath}", is not either a file or directory`);
        }
    }
    await fsRmdir(dirPath);
}

async function processCopy(workingPath: string, targetPath: string, files: string[]): Promise<void> {
    if (! await fsExist(targetPath)) {
        await fsMkdir(targetPath);
    }

    for (const itemName of files) {
        const sourceItemPath = Path.join(workingPath, itemName);
        const targetItemPath = Path.join(targetPath, itemName);
        if (!await fsExist(sourceItemPath)) {
            copyLogger.warn(`item "${sourceItemPath}" not exists, skip`);
            continue;
        }
        const stat = await fsStat(sourceItemPath);
        if (stat.isFile()) {
            copyLogger.trace(`copy file "${itemName}"`);
            await fsCopyFile(sourceItemPath, targetItemPath);
        } else if (stat.isDirectory()) {
            copyLogger.trace(`copy directory "${itemName}"`);
            await copyDirectory(sourceItemPath, targetItemPath);
        } else {
            copyLogger.warn(`item "${sourceItemPath}" is not either a file or a directory`);
        }
    }
}

async function copyDirectory(sourcePath: string, targetPath: string) {
    if (! await fsExist(targetPath)) {
        await fsMkdir(targetPath);
    }
    const files = await fsReaddir(sourcePath);
    for (const itemName of files) {
        const sourceItemPath = Path.join(sourcePath, itemName);
        const targetItemPath = Path.join(targetPath, itemName);
        const itemStat = await fsStat(sourceItemPath);
        if (itemStat.isFile()) {
            await fsCopyFile(sourceItemPath, targetItemPath);
        } else if (itemStat.isDirectory()) {
            await copyDirectory(sourceItemPath, targetItemPath);
        }
    }
}

async function processPack(workingPath: string, targetFilePath: string): Promise<void> {
    actionLogger.trace(`chdir to "${workingPath}"`);
    const targetFile = FS.createWriteStream(targetFilePath);
    const archive = Archiver('zip', { zlib: { level: 1 } });
    archive.on('close', () => {
        archiverLogger.info(`finalized, total ${archive.pointer()} bytes`);
    });
    archive.on('warning', (err) => {
        archiverLogger.warn(err);
    });
    archive.on('error', (err) => {
        archiverLogger.error(err);
        throw err;
    });
    archive.pipe(targetFile);
    // for (const itemName of files) {
    //     const itemPath = Path.join(workingPath, itemName);
    //     if (!await fsExist(itemPath)) {
    //         archiverLogger.warn(`"${itemName}" not exists, skip`);
    //         continue;
    //     }
    //     const stat = await fsStat(itemPath);
    //     if (stat.isFile()) {
    //         archiverLogger.trace(`add file ${itemName}"`);
    //         archive.file(itemName, { name: itemPath });
    //     } else if (stat.isDirectory) {
    //         archiverLogger.trace(`add directory ${itemName}"`);
    //         archive.directory(itemPath, itemName);
    //     } else {
    //         archiverLogger.warn(`path "${itemName}" is not either file or directory`);
    //     }
    // }
    archive.directory(workingPath, false);
    await archive.finalize();
}

async function fsExist(path: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        FS.access(path, FS.constants.F_OK, (err) => {
            if (err) {
                resolve(false);
            } else {
                resolve(true);
            }
        });
    })
}

interface Configuration {
    name: string;
    targetPath: string;
    copyBefore: string[][];
    copyAfter: string[][],
    files: string[],
    packBefore: string[][],
    packAfter: string[][]
}
