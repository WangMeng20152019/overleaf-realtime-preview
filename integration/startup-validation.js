/** Bounded independent read validation. Never schedules new work after a failure;
 * all already-running work settles before propagating the original error. */
export async function validateStartup(items,validate,limit=4){
 if(!Number.isSafeInteger(limit)||limit<1||limit>4)throw Error('Invalid startup concurrency');
 const list=[...items];let next=0,failure;
 await Promise.all(Array.from({length:Math.min(limit,list.length)},async()=>{while(failure===undefined&&next<list.length){const index=next++;try{await validate(list[index],index);}catch(error){failure??={error};}}}));
 if(failure)throw failure.error;
}
