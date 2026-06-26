let _io = null;

function setIo(io) { _io = io; }

function emitToUser(userId, event, data) {
  if (_io) _io.to(`user:${userId}`).emit(event, data);
}

function emitAll(event, data) {
  if (_io) _io.emit(event, data);
}

module.exports = { setIo, emitToUser, emitAll };
