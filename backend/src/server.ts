require("dotenv").config()
import express from "express"
import * as Http from "http"
import * as Https from "https"
import IO from "socket.io"
import { connectionHandler } from "./connection-handler"
import { initDB } from "./db"
import fs from "fs"
import path from "path"
import config from "./config"
import bodyParser from "body-parser"
import { Board, createBoard } from "../../common/src/domain"
import { addBoard } from "./board-store"

const app = express();
let http = new Http.Server(app);
let io = IO(http);

app.use("/", express.static("../frontend/dist"))
app.use("/", express.static("../frontend/public"))

if (config.STORAGE_BACKEND === "LOCAL") {
    app.put("/assets/:id", (req, res) => {
        if (!req.params.id) {
            return res.sendStatus(400)
        }

        const w = fs.createWriteStream(config.LOCAL_FILES_DIR + "/" + req.params.id)

        req.pipe(w)

        req.on("end", () => {
            !res.headersSent && res.sendStatus(200)
        })

        w.on("error", () => {
            res.sendStatus(500)
        })
    })
    app.use("/assets", express.static(config.LOCAL_FILES_DIR))
}
app.get("/assets/external", (req, res) => {
    const src = req.query.src
    if (typeof src !== "string" || ["http://", "https://"].every(prefix => !src.startsWith(prefix))) return res.send(400)
    const protocol = src.startsWith("https://") ? Https : Http 

    protocol.request(src, upstreamResponse => {
        res.writeHead(upstreamResponse.statusCode!, upstreamResponse.headers);
        upstreamResponse
          .pipe(
            res,
            {
              end: true
            }
          )
          .on("error", err => res.status(500).send(err.message));
      }).end();
})

app.get("/b/:boardId", async (req, res) => {    
    res.sendFile(path.resolve("../frontend/dist/index.html"))
})

app.post("/api/v1/board", bodyParser.json(), async (req, res) => {
    let { name } = req.body
    if (!name) {
        res.status(400).send("Expecting JSON document containing the field \"name\".");
    }
    let board: Board = createBoard(name)
    const boardWithHistory = await addBoard(board)
    res.json(boardWithHistory.board)
})

io.on("connection", connectionHandler)

const port = process.env.PORT || 1337

initDB()
    .then(() => {
        http.listen(port, () => {
            console.log("Listening on port " + port)
        })
    })
    .catch(e => {
        console.error(e)
    })