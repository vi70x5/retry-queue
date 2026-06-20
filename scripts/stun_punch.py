import socket
import struct
import sys
import random

def get_stun_mapping(local_port, stun_host="stun.l.google.com", stun_port=19302):
    # STUN Binding Request transaction ID
    tx_id = bytes(random.getrandbits(8) for _ in range(16))
    # STUN Binding Request header (Type: 0x0001, Length: 0x0000, Magic Cookie: 0x2112A442, Transaction ID)
    request = struct.pack("!HHI", 0x0001, 0x0000, 0x2112A442) + tx_id

    # Create UDP socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    except AttributeError:
        pass # SO_REUSEPORT might not be available on some platforms

    sock.bind(("0.0.0.0", local_port))
    sock.settimeout(5.0)

    try:
        # Resolve stun host
        stun_ip = socket.gethostbyname(stun_host)
        sock.sendto(request, (stun_ip, stun_port))

        # Read response
        data, addr = sock.recvfrom(2048)
        if len(data) < 20:
            return None

        # Parse STUN header
        msg_type, msg_len, magic = struct.unpack("!HHI", data[:8])
        if msg_type != 0x0101: # Binding Success Response
            return None

        # Parse attributes to find MAPPED-ADDRESS or XOR-MAPPED-ADDRESS
        offset = 20
        while offset < len(data):
            attr_type, attr_len = struct.unpack("!HH", data[offset:offset+4])
            val_offset = offset + 4

            if attr_type == 0x0001: # MAPPED-ADDRESS
                family, port = struct.unpack("!BBH", data[val_offset:val_offset+4])
                ip_bytes = data[val_offset+4 : val_offset+4+4]
                ip = socket.inet_ntoa(ip_bytes)
                return ip, port

            elif attr_type == 0x0020: # XOR-MAPPED-ADDRESS
                # XOR-MAPPED-ADDRESS uses XOR of magic cookie & transaction ID
                family, xport = struct.unpack("!BBH", data[val_offset:val_offset+4])
                port = xport ^ 0x2112
                xip = data[val_offset+4 : val_offset+4+4]
                # XOR with Magic Cookie (0x2112A442)
                magic_bytes = struct.pack("!I", 0x2112A442)
                ip_bytes = bytes(xip[i] ^ magic_bytes[i] for i in range(4))
                ip = socket.inet_ntoa(ip_bytes)
                return ip, port

            # Attribute length must be padded to a multiple of 4
            offset += 4 + ((attr_len + 3) & ~3)

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
    finally:
        sock.close()
    return None

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python stun_punch.py <local_port>", file=sys.stderr)
        sys.exit(1)

    local_port = int(sys.argv[1])
    mapping = get_stun_mapping(local_port)
    if mapping:
        print(f"{mapping[0]}:{mapping[1]}")
    else:
        print("FAILED", file=sys.stderr)
        sys.exit(1)
