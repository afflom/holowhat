import { Repo } from "npm:@automerge/automerge-repo"
import { WebSocketClientAdapter } from "npm:@automerge/automerge-repo-network-websocket"
import { NodeFSStorageAdapter } from "npm:@automerge/automerge-repo-storage-nodefs"

const repo = new Repo({
  storage: new NodeFSStorageAdapter(),
  network: [new WebSocketClientAdapter("wss://sync.playground.now")],
})

export default repo
