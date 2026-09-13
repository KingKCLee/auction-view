const {spawn}=require('child_process');

const [, , msArg, command, ...args]=process.argv;
const ms=Number(msArg);
if(!Number.isFinite(ms)||ms<=0||!command){
  console.error('usage: node run-bounded.js <milliseconds> <command> [args...]');
  process.exit(2);
}

const child=spawn(command,args,{stdio:'inherit',shell:false});
let timedOut=false;
const timer=setTimeout(()=>{
  timedOut=true;
  console.error(`[bounded] ${command} exceeded ${ms}ms; terminating`);
  try{child.kill('SIGTERM')}catch{}
  setTimeout(()=>{try{child.kill('SIGKILL')}catch{}},5000).unref();
},ms);

child.on('error',err=>{
  clearTimeout(timer);
  console.error(`[bounded] failed to start ${command}: ${err.message}`);
  process.exitCode=1;
});
child.on('exit',(code,signal)=>{
  clearTimeout(timer);
  if(timedOut){process.exitCode=124;return;}
  if(signal){console.error(`[bounded] ${command} exited by ${signal}`);process.exitCode=1;return;}
  process.exitCode=code??1;
});
