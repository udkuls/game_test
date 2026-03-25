// server.js - WebSocket сервер для ретрансляции
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
    // Отдаем HTML файл
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'game.html'), (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

const wss = new WebSocket.Server({ server });

// Хранилище комнат
const rooms = new Map();

wss.on('connection', (ws) => {
    let currentRoom = null;
    let playerId = null;
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'createRoom':
                    // Создаем новую комнату
                    playerId = Math.random().toString(36).substring(2, 10);
                    currentRoom = playerId;
                    rooms.set(currentRoom, {
                        host: ws,
                        guest: null,
                        players: {
                            host: { ws, ready: false, name: data.name, id: playerId, x: 400, y: 300 },
                            guest: null
                        }
                    });
                    ws.send(JSON.stringify({
                        type: 'roomCreated',
                        roomId: currentRoom,
                        playerId: playerId,
                        playerNumber: 1
                    }));
                    console.log(`Комната создана: ${currentRoom}`);
                    break;
                    
                case 'joinRoom':
                    const room = rooms.get(data.roomId);
                    if (room && !room.guest) {
                        playerId = Math.random().toString(36).substring(2, 10);
                        currentRoom = data.roomId;
                        room.guest = ws;
                        room.players.guest = {
                            ws, ready: false, name: data.name, id: playerId, x: 400, y: 300
                        };
                        
                        // Уведомляем хоста
                        room.host.send(JSON.stringify({
                            type: 'playerJoined',
                            playerName: data.name,
                            playerId: playerId
                        }));
                        
                        // Отправляем гостю информацию
                        ws.send(JSON.stringify({
                            type: 'joined',
                            roomId: data.roomId,
                            playerId: playerId,
                            playerNumber: 2,
                            hostName: room.players.host.name
                        }));
                        
                        console.log(`Игрок ${data.name} присоединился к комнате ${data.roomId}`);
                    } else if (room && room.guest) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Комната уже заполнена'
                        }));
                    } else {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Комната не найдена'
                        }));
                    }
                    break;
                    
                case 'startGame':
                    const startRoom = rooms.get(currentRoom);
                    if (startRoom && startRoom.host === ws) {
                        startRoom.gameStarted = true;
                        // Уведомляем всех игроков
                        startRoom.host.send(JSON.stringify({ type: 'gameStarted' }));
                        if (startRoom.guest) {
                            startRoom.guest.send(JSON.stringify({ type: 'gameStarted' }));
                        }
                    }
                    break;
                    
                case 'playerMove':
                    const moveRoom = rooms.get(currentRoom);
                    if (moveRoom) {
                        // Отправляем позицию другому игроку
                        const target = moveRoom.host === ws ? moveRoom.guest : moveRoom.host;
                        if (target) {
                            target.send(JSON.stringify({
                                type: 'playerMove',
                                playerId: data.playerId,
                                x: data.x,
                                y: data.y
                            }));
                        }
                    }
                    break;
                    
                case 'chat':
                    const chatRoom = rooms.get(currentRoom);
                    if (chatRoom) {
                        const sender = chatRoom.host === ws ? 'host' : 'guest';
                        const messageData = {
                            type: 'chat',
                            message: data.message,
                            sender: data.sender,
                            timestamp: Date.now()
                        };
                        chatRoom.host.send(JSON.stringify(messageData));
                        if (chatRoom.guest) {
                            chatRoom.guest.send(JSON.stringify(messageData));
                        }
                    }
                    break;
                    
                case 'playerReady':
                    const readyRoom = rooms.get(currentRoom);
                    if (readyRoom) {
                        if (readyRoom.host === ws) {
                            readyRoom.players.host.ready = true;
                        } else if (readyRoom.guest === ws) {
                            readyRoom.players.guest.ready = true;
                        }
                        
                        // Уведомляем всех о готовности
                        const hostReady = readyRoom.players.host.ready;
                        const guestReady = readyRoom.players.guest ? readyRoom.players.guest.ready : false;
                        
                        readyRoom.host.send(JSON.stringify({
                            type: 'playersReady',
                            hostReady,
                            guestReady
                        }));
                        if (readyRoom.guest) {
                            readyRoom.guest.send(JSON.stringify({
                                type: 'playersReady',
                                hostReady,
                                guestReady
                            }));
                        }
                    }
                    break;
                    
                case 'syncPlayers':
                    const syncRoom = rooms.get(currentRoom);
                    if (syncRoom) {
                        const playerData = {
                            host: syncRoom.players.host,
                            guest: syncRoom.players.guest
                        };
                        ws.send(JSON.stringify({
                            type: 'syncPlayers',
                            players: playerData
                        }));
                    }
                    break;
            }
        } catch (err) {
            console.error('Ошибка обработки сообщения:', err);
        }
    });
    
    ws.on('close', () => {
        if (currentRoom) {
            const room = rooms.get(currentRoom);
            if (room) {
                if (room.host === ws) {
                    // Хост ушел - закрываем комнату
                    if (room.guest) {
                        room.guest.send(JSON.stringify({
                            type: 'hostDisconnected',
                            message: 'Хост отключился'
                        }));
                        room.guest.close();
                    }
                    rooms.delete(currentRoom);
                    console.log(`Комната ${currentRoom} удалена (хост отключился)`);
                } else if (room.guest === ws) {
                    // Гость ушел
                    room.guest = null;
                    room.players.guest = null;
                    room.host.send(JSON.stringify({
                        type: 'guestDisconnected',
                        message: 'Игрок отключился'
                    }));
                    console.log(`Гость покинул комнату ${currentRoom}`);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════════════════╗
    ║   🎮 WebSocket Game Server запущен!              ║
    ╠══════════════════════════════════════════════════╣
    ║   Локальный: http://localhost:${PORT}              ║
    ║   Для доступа из интернета используйте ngrok    ║
    ║   Команда: ngrok http ${PORT}                      ║
    ╚══════════════════════════════════════════════════╝
    `);
});