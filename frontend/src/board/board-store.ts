import * as L from "lonna";
import { globalScope } from "lonna";
import { AppEvent, Board, EventFromServer, CURSOR_POSITIONS_ACTION_TYPE, Id, ItemLocks, EventUserInfo, UserCursorPosition, UserSessionInfo, isPersistableBoardItemEvent, BoardHistoryEntry, isBoardItemEvent, BoardItemEvent, PersistableBoardItemEvent } from "../../../common/src/domain";
import { boardHistoryReducer, boardReducer } from "../../../common/src/state";
import { foldActions } from "../../../common/src/action-folding";
import MessageQueue from "./message-queue";
import { buildBoardFromHistory } from "../../../common/src/migration";


export type BoardAppState = {
    board: Board | undefined,
    history: BoardHistoryEntry[],
    userId: Id | null
    nickname: string | undefined,
    users: UserSessionInfo[]
    cursors: Record<Id, UserCursorPosition>
    locks: ItemLocks
}

export type BoardStore = ReturnType<typeof boardStore>

export type Dispatch = (e: AppEvent) => void

export function boardStore(socket: typeof io.Socket) {
    const uiEvents = L.bus<AppEvent>()
    const dispatch: Dispatch = uiEvents.push
    const serverEvents = L.bus<EventFromServer>()    
    const messageQueue = MessageQueue(socket)
    socket.on("connect", () => { 
        console.log("Socket connected")
        messageQueue.onConnect()
    })
    socket.on("message", function(kind: string, event: EventFromServer) { 
        if (kind === "app-event") {
            serverEvents.push(event)
        }
    })
    L.pipe(uiEvents, L.filter((e: AppEvent) => e.action !== "undo" && e.action !== "redo")).forEach(messageQueue.enqueue)
    const userTaggedLocalEvents = L.view(uiEvents, tagWithUser)
    
    function tagWithUser(e: AppEvent): EventFromServer {
        return isPersistableBoardItemEvent(e) ? getUserFromState(e) : e
    }
    function getUserFromState(e: PersistableBoardItemEvent): BoardHistoryEntry {
        return { ...e, user: { userType: "unidentified", nickname: state.get().nickname || "UNKNOWN" }, timestamp: new Date().toISOString() }
    }

    // uiEvents.log("UI")
    // serverEvents.log("Server")
    
    const events = L.merge(userTaggedLocalEvents, serverEvents)
    let undoStack: AppEvent[] = []
    let redoStack: AppEvent[] = []

    const eventsReducer = (state: BoardAppState, event: EventFromServer) => {
        if (event.action === "undo") {
            if (!undoStack.length) return state
            const undoOperation = undoStack.pop()!
            messageQueue.enqueue(undoOperation)
            const [{board, history}, reverse] = boardHistoryReducer({ board: state.board!, history: state.history}, tagWithUser(undoOperation))
            if (reverse) redoStack = addToStack(reverse, redoStack)
            return { ...state, board, history }
        } else if (event.action === "redo") {
            if (!redoStack.length) return state
            const redoOperation = redoStack.pop()!
            messageQueue.enqueue(redoOperation)
            const [{board, history}, reverse] = boardHistoryReducer({ board: state.board!, history: state.history}, tagWithUser(redoOperation))
            if (reverse) undoStack = addToStack(reverse, undoStack)
            return { ...state, board, history }
        } else if (isBoardItemEvent(event)) {            
            const [{board, history}, reverse] = boardHistoryReducer({ board: state.board!, history: state.history}, event)
            if (reverse) {
                redoStack = []
                undoStack = addToStack(reverse, undoStack)
            }
            return { ...state, board, history }
        } else if (event.action === "board.init") {
            return { ...state, board: buildBoardFromHistory(event.board.boardAttributes, event.board.history), history: event.board.history }
        } else if (event.action === "board.join.ack") {
            let nickname = event.nickname
            if (localStorage.nickname && localStorage.nickname !== event.nickname) {
                nickname = localStorage.nickname
                dispatch({ action: "nickname.set", userId: event.userId, nickname })                
            }
            return { ...state, userId: event.userId, nickname }
        } else if (event.action === "board.joined") {
            return { ...state, users: state.users.concat({ userId: event.userId, nickname: event.nickname }) }
        } else if (event.action === "board.locks") {
            return { ...state, locks: event.locks }
        } else if (event.action === CURSOR_POSITIONS_ACTION_TYPE) {
            return { ...state, cursors: event.p }
        } else if (event.action === "cursor.move") {
            return state
        } else if (event.action === "nickname.set") {
            const nickname = (event.userId === state.userId) ? storeNickName(event.nickname) : state.nickname
            const users = state.users.map(u => u.userId === event.userId ? { ...u, nickname: event.nickname } : u)
            return { ...state, users, nickname }
        } else {
            console.warn("Unhandled event", event)
            return state
        }
    }
    
    const initialState = { board: undefined, history: [], userId: null, nickname: undefined, users: [], cursors: {}, locks: {} }
    const state = events.pipe(L.scan(initialState, eventsReducer, globalScope))
    
    return {
        state,
        dispatch,
        events,    
        queueSize: messageQueue.queueSize,
        boardId: L.constant(boardIdFromPath())
    }
}

function storeNickName(nickname: string) {
    localStorage.nickname = nickname
    return nickname
}

function boardIdFromPath() {
    const match = document.location.pathname.match(/b\/(.*)/)
    return (match && match[1]) || undefined
}

export function addToStack(event: AppEvent, b:AppEvent[]) {
    const latest = b[b.length - 1]
    if (latest) {
        const folded = foldActions(event, latest)  // The order is like this, because when applied the new event would be applied before the one in the stack
        if (folded) {
            return [...b.slice(0, b.length - 1), folded] // Replace top of stack with folded
        }
    }
    
    return b.concat(event)
}