import * as vscode from 'vscode';
import Window = vscode.window;
import * as https from 'https';
import * as constants from 'constants';
var cookie = require('cookie');
import * as fs from 'fs';
import * as cp from 'child_process';
import spgit = require('./spgit');
import helpers = require('./helpers');

var Urls = {
    login: 'login.microsoftonline.com',
    signin: "/_forms/default.aspx?wa=wsignin1.0",
    sts: "/extSTS.srf"
};
var tokens = {
    security: '',
    access: ''
};

var auth : sp.Auth;
var config;
var wkConfig:any;
var ctx:vscode.ExtensionContext;

var currentUser:vscode.StatusBarItem = Window.createStatusBarItem(vscode.StatusBarAlignment.Right);

var mkdir = (path:string, root?:string) => {
    var dirs = path.split('/'),
        dir = dirs.shift();
    root = (root || '') + dir + '/';
    try { fs.mkdirSync(root); }
    catch (e) {
        if(!fs.statSync(root).isDirectory()) throw new Error(e);
    }
    return !dirs.length || mkdir(dirs.join('/'), root);
};

module sp {
    export interface Params {
        hostname: string;
        path?: string;
        method: string;
        secureOptions: number;
        headers: any;
        keepAlive?: boolean;
    }
    export interface Project {
        site?: string;
        title: string;
        url: string;
        user: string;
        pwd: string;
    }
    export class Auth {
        token: string;
        digest: string;
        project: Project;
        constructor(){
        }
    }
    // Request wrapper
    export class Request {
        digest: string;
        params: sp.Params;
        data: any;
        rawResult: boolean;
        ignoreAuth: boolean;
        onResponse: (any) => void;
        constructor () {
            this.params = {
                method: 'GET',
                hostname: auth.project.url.split('/')[2],
                secureOptions: constants.SSL_OP_NO_TLSv1_2,
                headers: {
                    'Accept': 'application/json; odata=nometadata'
                }
            };
            if (auth.token) this.params.headers.Cookie = auth.token;
            this.rawResult = false; 
        }
        private error = (error) => {
            Window.showWarningMessage(error);
        }
        // Send and authenticate if needed
        send = () => {
            var self = this;
            var authenticated = new Promise((resolve, reject) => {
                if (auth.token || self.ignoreAuth) resolve();
                else
                    authenticate().then(() => {
                        resolve();
                    });
            });
            var promise = new Promise((resolve,reject) => {
                authenticated.then(() => {
                    if (!self.ignoreAuth) self.params.path = auth.project.site + self.params.path;
                    if (!self.params.headers.Cookie && auth.token) self.params.headers.Cookie = auth.token;
                    if( !self.params.path.length ) {
                        console.warn('No request path specified.');
                        reject(null);
                        return false;
                    }
                    var request = https.request(self.params, (res) => {
                        if(self.onResponse) self.onResponse(res);
                        var data:string = '';
                        res.on('data', (chunk) => {
                            data += chunk;
                        });
                        res.on('error', (err) => {
                            self.error(err.message);
                        });
                        res.on('end', () => {
                            var result = self.rawResult ? data : JSON.parse(data); 
                            if (!self.rawResult && result['odata.error']) {
                                self.error(result['odata.error'].message.value);
                                return false;
                            }
                            resolve(result);
                        });
                    });
                    request.end(self.data || null);
                });
            });
            return promise;
        }
    }
    // Parse URL and get site collection URL
    var getSiteCollection = (url:string) => {
        var last:string = url[url.length - 1];
        if (last === '/') url = url.substring(0, url.length - 1);
        var split = url.split('/');
        var domain:string = split[2];
        return (split.length > 3) ? url.split(domain)[1] : '';
    };
    // SharePoint authentication
    var authenticate = () => {
        var credentials = new helpers.Credentials();
        var promise = new Promise((resolve, reject) => {
            credentials.get(auth.project.url.split('/')[2]).then((credentials:helpers.spCredentials) => {
                var enveloppe:string = fs.readFileSync(ctx.extensionPath + '/credentials.xml', 'utf8');
                var compiled:string = enveloppe.split('[username]').join(credentials.username);
                compiled = compiled.split('[password]').join(credentials.password);
                compiled = compiled.split('[endpoint]').join(auth.project.url);
                // 1. Send: XML with credentials, Get: Security token
                var getSecurityToken = new sp.Request();
                getSecurityToken.params.hostname = Urls.login;
                getSecurityToken.params.path = Urls.sts;
                getSecurityToken.params.method = 'POST';
                getSecurityToken.params.keepAlive = true;
                getSecurityToken.params.headers = {
                    'Accept': 'application/json; odata=verbose',
                    'Content-Type': 'application/xml',
                    'Content-Length': Buffer.byteLength(compiled)
                };
                getSecurityToken.ignoreAuth = true;
                delete getSecurityToken.params.secureOptions;
                getSecurityToken.data = compiled;
                getSecurityToken.rawResult = true;
                getSecurityToken.send().then((data:string) => {
                    var bits = data.split('<wsse:BinarySecurityToken Id="Compact0">');
                    if(bits.length < 2) {
                        Window.showErrorMessage('Authentication failed.');
                        return false;
                    }
                    tokens.security = bits[1].split('</wsse:BinarySecurityToken>')[0];
                    // 2. Send: Security token, Get: Access token (cookies)
                    var getAccessToken = new sp.Request();
                    getAccessToken.params.path = Urls.signin;
                    getAccessToken.params.method = 'POST';
                    getAccessToken.params.headers = {
                        'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Win64; x64; Trident/5.0)',
                        'Content-Type': 'application/x-www-form-urlencoded',                
                        'Content-Length': Buffer.byteLength(tokens.security)
                    };
                    getAccessToken.rawResult = true;
                    getAccessToken.data = tokens.security;
                    getAccessToken.ignoreAuth = true;
                    getAccessToken.onResponse = (res) => {
                        var cookies = cookie.parse(res.headers["set-cookie"].join(";"));
                        tokens.access =  'rtFa=' + cookies['rtFa'] + '; FedAuth=' + cookies['FedAuth'] + ';';
                        auth.token = tokens.access;
                    };
                    getAccessToken.send().then(() => {
                        var user = new sp.Request();
                        user.params.path = '/_api/SP.UserProfiles.PeopleManager/GetMyProperties?$select=DisplayName';
                        user.send().then((data:any) => {
                            currentUser.text = '$(hubot) ' + data.DisplayName;
                            currentUser.tooltip = 'SPTools: Authenticated as ' + data.DisplayName;
                            currentUser.show();
                            resolve();
                        })
                    });
                });
            });
        });
        return promise;
    };
    // Get file properties
    var getProperties = (fileName:string) => {
        var properties = new sp.Request();
        properties.params.path = '/_api/web/getfilebyserverrelativeurl(\'' + encodeURI(fileName) + '\')/?$select=Name,ServerRelativeUrl,CheckOutType,TimeLastModified';
        return properties.send();
    }
    // Init workspace
    export var open = (options:sp.Project) => {
		if( !options.title || !options.url) {
            Window.showWarningMessage('Please fill all the inputs');
            return false;
        }
        var workfolder = config.path + options.title;
        mkdir(workfolder);
        fs.writeFileSync(workfolder + '/spconfig.json', '{"site": "' + options.url + '"}');
        auth.project = options;
        auth.project.site = getSiteCollection(options.url);
        spgit.init(workfolder, () => {
            Window.showInformationMessage('GIT initialized');
            var request = new sp.Request();
            sp.get(config.spFolders, options, tokens);
        });
    };
    // Get and store Extension context
    export var getContext = (context:vscode.ExtensionContext) => {
        auth = new sp.Auth();
        auth.project = <sp.Project>{};
        if (vscode.workspace.rootPath) {
            wkConfig = JSON.parse(fs.readFileSync(vscode.workspace.rootPath + '/spconfig.json', 'utf-8'));
            auth.project.url = wkConfig.site;
            auth.project.site = getSiteCollection(wkConfig.site);
        }
        helpers.getContext(context);
        ctx = context;
    };
    // Get Extension settings
    export var getConfig = (path:string) => {
        config = vscode.workspace.getConfiguration('sptools');
        var wk:string = config.workFolder;
        config.path = wk + (wk.substring(wk.length - 1, wk.length) === '\\' ? '' : '\\');
        try { fs.statSync(config.path); }
        catch (err) {
            Window.showWarningMessage(config.path + ' does not exist.', 'Create').then((selection) => {
                if (selection === 'Create') mkdir(config.path);
            });
        }
    };
    // Check file dates and status
    export var checkFileState = (file:string) => {
        var promise = new Promise((resolve, reject) => {
            getProperties(file).then((data:any) => {
                fs.stat(vscode.workspace.rootPath + file, (err, stats) => {
                    var local:Date = stats.mtime;
                    data.LocalModified = local;
                    resolve(data);
                });
            });
        });
        return promise;
    }
    // Resolve and download files
    export var get = (folders, project, tokens) => {
		// 1. Get request digest
		var digest = new sp.Request();
        digest.params.path = '/_api/contextinfo';
        digest.params.method = 'POST';
        digest.send().then((data:any) => {
            auth.digest = data.FormDigestValue;
            var workfolder = config.path.split('\\').join('/') + auth.project.title;
            var promise = new Promise((resolve,reject) => {
                folders.forEach((folder, folderIndex) => {
                    // 2. Get list ID
                    var listId = new sp.Request();
                    listId.params.path = '/_api/web/GetFolderByServerRelativeUrl(\'' + encodeURI(auth.project.site + folder) + '\')/properties?$select=vti_listname';
                    listId.send().then((data:any) => {
                        var id = data.vti_x005f_listname.split('{')[1].split('}')[0];
                        // 3. Get folder items
                        var listItems = new sp.Request();
                        listItems.params.path = '/_api/lists(\'' + id + '\')/getItems?$select=FileLeafRef,FileRef,FSObjType,Modified';
                        listItems.params.method = 'POST';
                        listItems.params.headers['X-RequestDigest'] = auth.digest;
                        listItems.params.headers['Content-Type'] = 'application/json; odata=verbose';
                        listItems.data = '{ "query" : {"__metadata": { "type": "SP.CamlQuery" }, "ViewXml": "<View Scope=\'RecursiveAll\'>';
                        listItems.data +=   '<Query><Where><And>';
                        listItems.data +=       '<Eq><FieldRef Name=\'FSObjType\' /><Value Type=\'Integer\'>0</Value></Eq>';
                        listItems.data +=       '<BeginsWith><FieldRef Name=\'FileRef\'/><Value Type=\'Text\'>' + auth.project.site + folder + '</Value></BeginsWith>';
                        listItems.data +=   '</And></Where></Query>';  
                        listItems.data += '</View>"} }';
                        listItems.send().then((data:any) => {
                            var items = data.value;
                            Window.showInformationMessage(folder + ': downloading ' + items.length + ' items');
                            // 4. Download items, create folder structure if doesn't exist
                            items.forEach((item, itemIndex) => {
                                // TODO: Continue if should be ignored
                                mkdir(item.FileRef.split(item.FileLeafRef)[0], workfolder);
                                sp.download(item.FileRef, workfolder).then(() => {
                                    if(itemIndex === items.length - 1 && folderIndex === folders.length - 1)
                                        resolve();
                                });
                            });
                        });
                    });
                });
            });
            promise.then(() => {
                // Open code using the work folder
                
                // cp.exec('code ' + workfolder);
            });
        });
	}
    // Download specific file
    export var download = (fileName:string, workfolder:string) => {
        var promise = new Promise((resolve,reject) => {
            getProperties(fileName).then((props:any) => {
                var download = new sp.Request();
                download.rawResult = true;
                download.params.path = '/_api/web/getfilebyserverrelativeurl(\'' + encodeURI(fileName) + '\')/$value';
                download.send().then((data:any) => {
                    fs.writeFile(workfolder + fileName, data, 'utf8', (err) => {
                        var modified:number = new Date(props.TimeLastModified).getTime() / 1000 | 0;
                        fs.utimes(workfolder + fileName, modified, modified, (err) => {
                            resolve(err);
                            if (err) throw err;
                        })
                        if (err) throw err;
                    });
                });
            });
        });
        return promise;        
    }
    // Resolve and download files
    export var upload = (fileName:string) => {
        var fileLeaf:string = fileName.split('/').pop();
        var folder:string = fileName.split(fileLeaf)[0];
        var threads = new Promise((resolve, reject) => {
            var buffer:Buffer;
            var requestDigest:string;
            // 1. Get buffer
            fs.readFile(vscode.workspace.rootPath + fileName, (err, data) => {
                if (err) reject(err);
                buffer = data;
                if (requestDigest) resolve({buffer: buffer, digest: requestDigest});
            });
            // 2. Get request digest
            var digest = new sp.Request();
            digest.params.path = '/_api/contextinfo';
            digest.params.method = 'POST';
            digest.send().then((data:any) => {
                auth.digest = data.FormDigestValue;
                requestDigest = data.FormDigestValue;
                if (buffer) resolve({buffer: buffer, digest: requestDigest});
            });
        });
        var promise = new Promise((resolve, reject) => {
            threads.then((data:any) => {
                // 3. Upload
                var upload = new sp.Request();
                upload.params.path = '/_api/web/getfolderbyserverrelativeurl(\'' + encodeURI(folder) + '\')/files/add(overwrite=true,url=\'' + encodeURI(fileLeaf) + '\')';
                upload.params.method = 'POST';
                upload.data = data.buffer;
                upload.params.headers['X-RequestDigest'] = data.digest;
                upload.send().then(() => {
                    resolve();
                });
            }, (err:any) => {
                resolve(err);
            });
        });
        return promise;
    };
};
export = sp;