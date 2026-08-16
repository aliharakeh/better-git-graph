export namespace main {
	
	export class BranchInfo {
	    name: string;
	    updated?: string;
	
	    static createFrom(source: any = {}) {
	        return new BranchInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.updated = source["updated"];
	    }
	}
	export class CommitNode {
	    hash: string;
	    branch: string;
	    timestamp: string;
	    author: string;
	    subject: string;
	    isMerge: boolean;
	    tags?: string[];
	
	    static createFrom(source: any = {}) {
	        return new CommitNode(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hash = source["hash"];
	        this.branch = source["branch"];
	        this.timestamp = source["timestamp"];
	        this.author = source["author"];
	        this.subject = source["subject"];
	        this.isMerge = source["isMerge"];
	        this.tags = source["tags"];
	    }
	}
	export class MergeEvent {
	    hash: string;
	    sourceBranch: string;
	    targetBranch: string;
	    sourceHash: string;
	    timestamp: string;
	    author: string;
	    subject: string;
	    commitCount: number;
	
	    static createFrom(source: any = {}) {
	        return new MergeEvent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hash = source["hash"];
	        this.sourceBranch = source["sourceBranch"];
	        this.targetBranch = source["targetBranch"];
	        this.sourceHash = source["sourceHash"];
	        this.timestamp = source["timestamp"];
	        this.author = source["author"];
	        this.subject = source["subject"];
	        this.commitCount = source["commitCount"];
	    }
	}
	export class RepoGraph {
	    path: string;
	    branches: string[];
	    commits: CommitNode[];
	    merges: MergeEvent[];
	
	    static createFrom(source: any = {}) {
	        return new RepoGraph(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.branches = source["branches"];
	        this.commits = this.convertValues(source["commits"], CommitNode);
	        this.merges = this.convertValues(source["merges"], MergeEvent);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

