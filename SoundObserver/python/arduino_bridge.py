import socket
import msgpack
import threading
import time

class ArduinoBridge:
    def __init__(self, socket_path="/var/run/arduino-router.sock"):
        self.socket_path = socket_path
        self.sock = None
        self.msg_counter = 0
        self.pending_responses = {}
        self.running = False
        self.recv_thread = None
        self.lock = threading.Lock()
        
    def connect(self):
        try:
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.connect(self.socket_path)
            
            self.running = True
            self.recv_thread = threading.Thread(target=self._receive_loop, daemon=True)
            self.recv_thread.start()
            
            return True
        except Exception as e:
            print(f"Connection failed: {e}")
            return False
    
    def call(self, method, *args, timeout=5):
        self.msg_counter += 1
        msgid = self.msg_counter
        
        message = [0, msgid, method, list(args)]
        packed = msgpack.packb(message)
        
        event = threading.Event()
        with self.lock:
            self.pending_responses[msgid] = {"event": event, "result": None, "error": None}
        
        self.sock.sendall(packed)
        
        if event.wait(timeout):
            with self.lock:
                response = self.pending_responses.pop(msgid)
            
            if response["error"]:
                raise Exception(response["error"])
            return response["result"]
        else:
            with self.lock:
                self.pending_responses.pop(msgid, None)
            raise TimeoutError(f"Timeout waiting for {method}")
    
    def notify(self, method, *args):
        message = [2, method, list(args)]
        packed = msgpack.packb(message)
        self.sock.sendall(packed)
    
    def disconnect(self):
        self.running = False
        if self.sock:
            self.sock.close()
        if self.recv_thread:
            self.recv_thread.join(timeout=1)
    
    def _receive_loop(self):
        unpacker = msgpack.Unpacker()
        while self.running:
            try:
                data = self.sock.recv(4096)
                if not data:
                    break
                
                unpacker.feed(data)
                for msg in unpacker:
                    self._handle_response(msg)
            except Exception as e:
                if self.running:
                    print(f"Receive error: {e}")
                break
    
    def _handle_response(self, msg):
        if not isinstance(msg, list) or len(msg) < 4:
            return
        
        msg_type, msgid, error, result = msg[0], msg[1], msg[2], msg[3]
        
        if msg_type != 1:
            return
        
        with self.lock:
            if msgid in self.pending_responses:
                self.pending_responses[msgid]["error"] = error
                self.pending_responses[msgid]["result"] = result
                self.pending_responses[msgid]["event"].set()
