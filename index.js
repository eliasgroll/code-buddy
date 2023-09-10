#! /usr/bin/env node

const fs = require('fs');
const fetch = require('cross-fetch');
const path = require('path');
const {exec} = require('child_process');
const config = require('./config.json');

const EXCLUDE_DIRS = [
    'node_modules', // Node.js modules
    '.git',         // Git data directory
    '__pycache__',  // Python cache directory
    '.pytest_cache', // Python pytest cache directory
    'dist',         // Common directory for distribution files
    'build',        // Common build directory for many languages
    '.svn',         // Subversion directory
    'vendor',       // Dependencies in Go and other languages
    'target',       // Common directory for build outputs in Java projects (Maven, etc.)
    '.idea',        // JetBrains IDE configuration directory
    '.vscode',      // VSCode configuration directory
    'bin',          // Common binary output directory
    'obj',          // Common object files for compiled languages
    'out',          // Common output directory for compiled files
    '.next',        // Next.js build output directory
    '.nuxt',        // Nuxt.js build output directory
    'jspm_packages', // JSPM packages directory
    'bower_components', // Bower packages directory
    'venv',         // Python virtual environment directory
    '.mypy_cache',  // MyPy cache directory for Python
    '.history',     // Directory created by some code editors to store file history
    '.docker',      // Docker configuration directory
];

const getFiles = async (dir, ignoreDirs = []) => {
    const result = {
        files: []
    };

    const filesAndDirs = fs.readdirSync(dir);

    for (const fileOrDir of filesAndDirs) {
        if (ignoreDirs.includes(fileOrDir)) continue;

        const fullPath = path.join(dir, fileOrDir);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
            const nestedResult = await getFiles(fullPath, ignoreDirs);
            result.files.push(...nestedResult.files);
        } else if (stats.isFile()) {
            result.files.push({filepath: fullPath, code: fs.readFileSync(fullPath, 'utf-8')});
        }
    }

    return result;
}

const abortIfUncommited = () => exec('git status --porcelain', (err, stdout, stderr) => {
    if (err) {
        logInPlace('Failed to execute git command', err);
        return;
    }

    if (stderr) {
        logInPlace('Git error:', stderr);
        return;
    }

    if (stdout) {
        logInPlace('There are uncommitted changes in the working directory. Aborting...');
        process.exit(1);
    } else {
        logInPlace('No uncommitted changes detected. Continuing...');
    }
});
const buildReq = (prompt, files) => {
    return {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
            model: config.model,
            messages: [

                {
                    "role": "system",
                    "content": `You are a code modification assistant. Your task is to help users by suggesting modifications and comments to the ${config.language} code files they provide based on the instructions given in the user_request. Please maintain the original functionality of the code as much as possible and make clear if a request cannot be fulfilled. Always finish your code, never provide todos. You are allowed to specify new files if the user did not provide any`
                },
                {
                    "role": "user",
                    "content": JSON.stringify({
                        "user_request": `${prompt}. You respond exclusively in the following format: ${JSON.stringify({
                            "files": [
                                {
                                    "filepath": "<FILEPATH1_HERE>",
                                    "code": "<CODE1_HERE>"
                                },
                                {
                                    "filepath": "<FILEPATH2_HERE>",
                                    "code": "<CODE2_HERE>"
                                }]
                        })}`,
                        "files": files
                    })
                }
            ]
        })
    };
}

const writeFiles = (data) => {
    data.files.forEach((file) => {
        const filepath = path.resolve(process.cwd(), file.filepath);
        const dir = path.dirname(filepath);

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, {recursive: true});
        }

        fs.writeFileSync(filepath, file.code, 'utf-8');
    });
}

const gitCommit = (message, callback) => {
    exec(`git add . && git commit -m "${message}"`, (error, stdout, stderr) => {
        if (error) {
            logInPlace(`Execution error: ${error}`);
            return callback(error, null);
        }
        if (stderr) {
            logInPlace(`Git error: ${stderr}`);
            return callback(error, null);
        }
        callback(null, stdout);
    });
}


const code = json => Object.entries(json).map(e => `File path: ${e[0]}\n\n File content: \n${e[1]}\n`).join('\n\n\n');

const callApi = (prompt) => fetch(new URL('/v1/chat/completions', config.endpoint), buildReq(prompt))
    .then(response => response.json())

const [nodePath, scriptPath, ...modificationPrompt] = process.argv;

if (modificationPrompt.length === 0) {
    console.error('Usage: codebuddy <modification_prompt>');
    process.exit(1);
}

const logInPlace = (message) => {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(message);
}

const extractJSON = (str) => {
    const jsonString = str.substring(str.indexOf('{'), str.lastIndexOf('}') + 1);
    return jsonString && JSON.parse(jsonString);
}


let timer = 0;
let interval;

const run = async () => {
    config.git && abortIfUncommited();
    const files = await getFiles('.', EXCLUDE_DIRS);

    interval ||= setInterval(() => logInPlace(`Writing your code...(${++timer}s elapsed)`), 1000);

    const r = await callApi(modificationPrompt.join(' '), files);
    const mod = r.choices.map(choice => choice.message.content).join('');

    try {
        const json = extractJSON(mod);
        writeFiles(json);
    } catch (e) {
        logInPlace(toString(e));
        run();
        return;
    }
    clearInterval(interval);
    config.git && gitCommit(modificationPrompt.join(' '), logInPlace);
}

void run();
