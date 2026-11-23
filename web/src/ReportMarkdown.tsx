import type {ReactNode} from "react";

// Deliberately restrictive text renderer. Never interpret raw HTML, create
// clickable model-supplied links or use dangerouslySetInnerHTML.
function inlineText(source:string):ReactNode[]{
 const pieces=source.split(/(\*\*[^*\n]+\*\*)/g);
 return pieces.map((part,index)=>part.startsWith("**")&&part.endsWith("**")
  ? <strong key={index}>{part.slice(2,-2)}</strong>
  : <span key={index}>{part}</span>);
}
function heading(line:string){
 const match=/^(#{1,4})\s+(.+)$/.exec(line);
 return match?{level:match[1].length,text:match[2]}:null;
}
function bullet(line:string){
 const match=/^\s*[-*]\s+(.+)$/.exec(line);
 return match?.[1]??null;
}
function ordered(line:string){
 const match=/^\s*\d+[.)]\s+(.+)$/.exec(line);
 return match?.[1]??null;
}

export function ReportMarkdown({content}:{content:string}){
 const lines=Array.from(content.replace(/\r\n?/g,"\n")).slice(0,6000).join("").split("\n");
 const blocks:ReactNode[]=[];
 let i=0;
 while(i<lines.length){
  const line=lines[i].trim();
  if(!line){i++;continue;}
  const h=heading(line);
  if(h){
   blocks.push(h.level<=2
    ? <h3 key={i}>{inlineText(h.text)}</h3>
    : <h4 key={i}>{inlineText(h.text)}</h4>);
   i++;continue;
  }
  if(bullet(line)!==null||ordered(line)!==null){
   const useOrdered=ordered(line)!==null;
   const start=i;
   const items:ReactNode[]=[];
   while(i<lines.length){
    const next=lines[i].trim();
    const text=useOrdered?ordered(next):bullet(next);
    if(text===null)break;
    items.push(<li key={i}>{inlineText(text)}</li>);
    i++;
   }
   blocks.push(useOrdered
    ? <ol key={start}>{items}</ol>
    : <ul key={start}>{items}</ul>);
   continue;
  }
  const first=i;
  const paragraph:string[]=[];
  while(i<lines.length){
   const next=lines[i].trim();
   if(!next||heading(next)||bullet(next)!==null||ordered(next)!==null)break;
   paragraph.push(next);i++;
  }
  blocks.push(<p key={first}>{inlineText(paragraph.join(" "))}</p>);
 }
 return <div className="report-markdown" aria-label="Informe de análisis IA">{blocks}</div>;
}

