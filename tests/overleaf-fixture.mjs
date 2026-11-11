// Explicit disposable acceptance data, executed only inside the pinned CE test container.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import Registration from '/overleaf/services/web/app/src/Features/User/UserRegistrationHandler.mjs';
import Creation from '/overleaf/services/web/app/src/Features/Project/ProjectCreationHandler.mjs';
import Entities from '/overleaf/services/web/app/src/Features/Project/ProjectEntityUpdateHandler.mjs';
import {db} from '/overleaf/services/web/app/src/infrastructure/mongodb.mjs';
const at=process.argv.indexOf('--state'),state=at>=0?process.argv[at+1]:null;
if(!state||!path.isAbsolute(state))throw Error('Explicit NEW disposable --state directory required');
await fs.mkdir(state,{mode:0o700});
const credentials={email:`rtex-${crypto.randomBytes(5).toString('hex')}@example.invalid`,password:crypto.randomBytes(24).toString('hex')};
const user=await Registration.promises.registerNewUser(credentials);
const main=String.raw`\documentclass{article}
\usepackage[fontset=fandol]{ctex}
\usepackage{amsmath,amssymb,amsthm}
\setlength{\textheight}{250pt}
\setlength{\parskip}{10pt}
\begin{document}
\section{Realtime preview acceptance}
First anchor 中文字体预热。 Existing math $\mathbb{R}+\mathbb{Z}$.

Second anchor remains visible below inserted text.

\begin{equation}\begin{aligned}a&=\mathbb{R}\\b&=\mathbb{Z}\end{aligned}\end{equation}
\input{included}
\newpage
\section{Distant section}
Distant anchor must follow current source.

Final anchor completes the synthetic document.
\end{document}
`;
const included='Included anchor 测试中文。\n\nAnother included paragraph.\n';
const project=await Creation.promises.createProjectFromSnippet(user._id,'Realtime integration acceptance',main.split('\n'));
await Entities.promises.addDoc(project._id,project.rootFolder[0]._id,'included.tex',included.split('\n'),user._id,null);
await db.projects.updateOne({_id:project._id},{$set:{compiler:'lualatex'}});
const current=await db.projects.findOne({_id:project._id},{projection:{rootFolder:1,rootDoc_id:1,compiler:1}});
for(const [name,data]of Object.entries({'credentials.json':JSON.stringify(credentials),'tree.json':JSON.stringify({project:{_id:String(current._id),rootDoc_id:String(current.rootDoc_id),rootFolder:current.rootFolder}}),'main.tex':main,'included.tex':included,'fixture.json':JSON.stringify({projectId:String(project._id),mainDocId:String(current.rootDoc_id),userId:String(user._id)})}))await fs.writeFile(path.join(state,name),data,{mode:0o600});
console.log(JSON.stringify({created:true,projectId:String(project._id),mainDocId:String(current.rootDoc_id),synthetic:true}));
process.exit(0);
