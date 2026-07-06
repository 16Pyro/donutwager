import os
import time
import psycopg2
import uuid
import re
from dotenv import load_dotenv
from mcrcon import MCRcon
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

load_dotenv()

DB_URL = os.getenv("DATABASE_URL")
RCON_HOST = os.getenv("RCON_HOST", "127.0.0.1")
RCON_PORT = int(os.getenv("RCON_PORT", 25575))
RCON_PASS = os.getenv("RCON_PASSWORD")
LOG_PATH = os.getenv("MINECRAFT_LOG_PATH")

pending_auth_tokens = {}

def get_db_connection():
    return psycopg2.connect(DB_URL)

def execute_rcon(command: str):
    try:
        with MCRcon(RCON_HOST, RCON_PASS, port=RCON_PORT) as mcr:
            response = mcr.command(command)
            return response
    except Exception as e:
        print(f"[RCON ERROR] Failed to connect: {e}")
        return None

def handle_player_command(player: str, command: str):
    command = command.strip().lower()
    
    if command.startswith("/donut balance"):
        try:
            # Note: We need a mapping from username to UUID, assuming we have it or use username
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute('SELECT balance FROM "User" WHERE username = %s', (player,))
            result = cur.fetchone()
            cur.close()
            conn.close()
            
            balance = result[0] if result else 0.0
            execute_rcon(f'tellraw {player} {{"text":"DonutWager | Your balance is ${balance:.2f}","color":"green"}}')
            
        except Exception as e:
            print(f"[DB ERROR] {e}")
            execute_rcon(f'tellraw {player} {{"text":"DonutWager | Failed to fetch balance.","color":"red"}}')

    elif command.startswith("/donut link"):
        token = str(uuid.uuid4())[:8]
        pending_auth_tokens[player] = token
        execute_rcon(f'tellraw {player} {{"text":"DonutWager | Link Token: {token}","color":"aqua"}}')
        execute_rcon(f'tellraw {player} {{"text":"DonutWager | Enter this on https://donutwager.net to link.","color":"gray"}}')

class LogTailer(FileSystemEventHandler):
    def __init__(self, file_path):
        self.file_path = file_path
        self._file = open(self.file_path, "r", encoding="utf-8")
        self._file.seek(0, 2)  # Go to the end of the file

    def on_modified(self, event):
        if event.src_path == self.file_path:
            for line in self._file.readlines():
                self.process_line(line)

    def process_line(self, line: str):
        # Regex to parse vanilla/Paper log chat or commands
        # Example: [15:00:00] [Server thread/INFO]: <cook45> /donut balance
        # Note: Player commands are not always logged by default unless enabled, 
        # or we might catch chat messages. We assume commands are logged.
        
        match = re.search(r'\[Server thread/INFO\]: <([^>]+)> (.*)', line)
        if not match:
             # Try standard command logging format
             match = re.search(r'\[Server thread/INFO\]: ([A-Za-z0-9_]+) issued server command: (.*)', line)
             
        if match:
            player = match.group(1)
            msg = match.group(2)
            
            if msg.startswith("/donut"):
                handle_player_command(player, msg)

def main():
    if not LOG_PATH or not os.path.exists(LOG_PATH):
        print(f"ERROR: Cannot find Minecraft log file at {LOG_PATH}")
        return

    print("Starting DonutWager Python Daemon...")
    print(f"Tailing log file: {LOG_PATH}")
    
    event_handler = LogTailer(LOG_PATH)
    observer = Observer()
    log_dir = os.path.dirname(LOG_PATH)
    observer.schedule(event_handler, path=log_dir, recursive=False)
    observer.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

if __name__ == "__main__":
    main()
