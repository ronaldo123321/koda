use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use base64::Engine;

use crate::durable::{
    create_private_directory, sync_directory, validate_private_directory, validate_private_file,
};
use crate::protocol::{AttachmentReadResult, ProtocolError};

pub const PTY_OUTPUT_SEGMENT_BYTES: u64 = 65_536;
const MAX_SEGMENTS: usize = 1_024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CursorBounds {
    pub earliest: u64,
    pub latest: u64,
}

#[derive(Clone, Debug)]
struct Segment {
    start: u64,
    length: u64,
    path: PathBuf,
}

pub struct PtyOutputStore {
    directory: PathBuf,
    limit: u64,
    segments: VecDeque<Segment>,
    latest: u64,
}

impl PtyOutputStore {
    pub fn open(directory: &Path, limit: u64) -> Result<Self, ProtocolError> {
        create_private_directory(directory)?;
        validate_private_directory(directory)?;
        let segments = scan_segments(directory)?;
        let latest = segments
            .back()
            .map_or(0, |segment| segment.start.saturating_add(segment.length));
        let mut store = Self {
            directory: directory.to_owned(),
            limit,
            segments,
            latest,
        };
        store.rotate()?;
        Ok(store)
    }

    pub fn bounds(&self) -> CursorBounds {
        CursorBounds {
            earliest: self
                .segments
                .front()
                .map_or(self.latest, |segment| segment.start),
            latest: self.latest,
        }
    }

    pub fn append(&mut self, mut bytes: &[u8]) -> Result<CursorBounds, ProtocolError> {
        while !bytes.is_empty() {
            let needs_segment = self
                .segments
                .back()
                .is_none_or(|segment| segment.length == PTY_OUTPUT_SEGMENT_BYTES);
            if needs_segment {
                self.create_segment()?;
            }
            let segment = self
                .segments
                .back_mut()
                .expect("PTY output segment exists after creation");
            let writable = usize::try_from(PTY_OUTPUT_SEGMENT_BYTES - segment.length)
                .unwrap_or(usize::MAX)
                .min(bytes.len());
            let mut file = OpenOptions::new()
                .append(true)
                .open(&segment.path)
                .map_err(output_error)?;
            file.write_all(&bytes[..writable]).map_err(output_error)?;
            file.flush().map_err(output_error)?;
            segment.length = segment.length.saturating_add(writable as u64);
            self.latest = self.latest.saturating_add(writable as u64);
            bytes = &bytes[writable..];
        }
        self.sync()?;
        self.rotate()?;
        Ok(self.bounds())
    }

    pub fn sync(&self) -> Result<(), ProtocolError> {
        if let Some(segment) = self.segments.back() {
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&segment.path)
                .map_err(output_error)?
                .sync_all()
                .map_err(output_error)?;
        }
        sync_directory(&self.directory);
        Ok(())
    }

    pub fn read(
        &self,
        job_id: &str,
        cursor: u64,
        maximum_bytes: u32,
        complete: bool,
    ) -> Result<AttachmentReadResult, ProtocolError> {
        let bounds = self.bounds();
        if cursor < bounds.earliest {
            return Ok(AttachmentReadResult::CursorExpired {
                job_id: job_id.to_owned(),
                cursor,
                earliest_cursor: bounds.earliest,
                latest_cursor: bounds.latest,
                complete,
            });
        }
        if cursor > bounds.latest {
            return Err(ProtocolError::new(
                "CURSOR_INVALID",
                format!(
                    "PTY output cursor {cursor} exceeds latest cursor {}.",
                    bounds.latest
                ),
            ));
        }

        let readable = bounds
            .latest
            .saturating_sub(cursor)
            .min(u64::from(maximum_bytes));
        let mut bytes = Vec::with_capacity(readable as usize);
        let mut position = cursor;
        for segment in &self.segments {
            if bytes.len() as u64 >= readable {
                break;
            }
            let end = segment.start.saturating_add(segment.length);
            if position >= end || position < segment.start {
                continue;
            }
            let offset = position - segment.start;
            let count = (readable - bytes.len() as u64).min(segment.length - offset);
            let mut file = File::open(&segment.path).map_err(output_error)?;
            file.seek(SeekFrom::Start(offset)).map_err(output_error)?;
            file.take(count)
                .read_to_end(&mut bytes)
                .map_err(output_error)?;
            position = position.saturating_add(count);
        }
        if position != cursor.saturating_add(readable) {
            return Err(ProtocolError::new(
                "PTY_OUTPUT_CORRUPT",
                "PTY output segments do not cover the requested cursor range.",
            ));
        }
        Ok(AttachmentReadResult::Ok {
            job_id: job_id.to_owned(),
            cursor,
            next_cursor: position,
            earliest_cursor: bounds.earliest,
            latest_cursor: bounds.latest,
            complete: complete && position == bounds.latest,
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }

    fn create_segment(&mut self) -> Result<(), ProtocolError> {
        let path = self.directory.join(segment_name(self.latest));
        crate::platform::state_security::open_new_private_file(&path)
            .map_err(output_error)?
            .sync_all()
            .map_err(output_error)?;
        self.segments.push_back(Segment {
            start: self.latest,
            length: 0,
            path,
        });
        sync_directory(&self.directory);
        Ok(())
    }

    fn rotate(&mut self) -> Result<(), ProtocolError> {
        while self.retained_bytes() > self.limit && self.segments.len() > 1 {
            let segment = self
                .segments
                .pop_front()
                .expect("multiple PTY segments include a first segment");
            std::fs::remove_file(segment.path).map_err(output_error)?;
            sync_directory(&self.directory);
        }
        Ok(())
    }

    fn retained_bytes(&self) -> u64 {
        self.segments.iter().map(|segment| segment.length).sum()
    }
}

pub fn validate_directory(directory: &Path) -> Result<(), ProtocolError> {
    validate_private_directory(directory)?;
    let _ = scan_segments(directory)?;
    Ok(())
}

fn scan_segments(directory: &Path) -> Result<VecDeque<Segment>, ProtocolError> {
    let mut segments = Vec::new();
    for (index, entry) in std::fs::read_dir(directory)
        .map_err(output_error)?
        .enumerate()
    {
        if index >= MAX_SEGMENTS {
            return Err(corrupt("PTY output contains too many segments."));
        }
        let entry = entry.map_err(output_error)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| corrupt("PTY output segment name is not UTF-8."))?;
        let start = parse_segment_name(&name)?;
        validate_private_file(&entry.path(), None)?;
        let length = entry.metadata().map_err(output_error)?.len();
        if length > PTY_OUTPUT_SEGMENT_BYTES {
            return Err(corrupt("PTY output segment exceeds 64 KiB."));
        }
        segments.push(Segment {
            start,
            length,
            path: entry.path(),
        });
    }
    segments.sort_by_key(|segment| segment.start);
    for pair in segments.windows(2) {
        if pair[0].length != PTY_OUTPUT_SEGMENT_BYTES
            || pair[0].start.saturating_add(pair[0].length) != pair[1].start
        {
            return Err(corrupt(
                "PTY output segment cursors are not contiguous and fixed-size.",
            ));
        }
    }
    Ok(segments.into())
}

fn segment_name(start: u64) -> String {
    format!("{start:020}.bin")
}

fn parse_segment_name(name: &str) -> Result<u64, ProtocolError> {
    let Some(number) = name.strip_suffix(".bin") else {
        return Err(corrupt("PTY output contains an unknown entry."));
    };
    if number.len() != 20 || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(corrupt("PTY output segment name is invalid."));
    }
    let start = number
        .parse::<u64>()
        .map_err(|_| corrupt("PTY output segment cursor is invalid."))?;
    if segment_name(start) != name {
        return Err(corrupt("PTY output segment name is not canonical."));
    }
    Ok(start)
}

fn output_error(error: std::io::Error) -> ProtocolError {
    ProtocolError::new(
        "PTY_OUTPUT_FAILED",
        format!("Could not maintain PTY output: {error}"),
    )
}

fn corrupt(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new("PTY_OUTPUT_CORRUPT", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn rotates_whole_segments_and_reports_expired_cursor() {
        let root =
            std::env::temp_dir().join(format!("koda-pty-output-{}", Uuid::new_v4().simple()));
        let mut store = PtyOutputStore::open(&root, PTY_OUTPUT_SEGMENT_BYTES).expect("store");
        store
            .append(&vec![7; PTY_OUTPUT_SEGMENT_BYTES as usize + 17])
            .expect("append");

        assert_eq!(
            store.bounds(),
            CursorBounds {
                earliest: PTY_OUTPUT_SEGMENT_BYTES,
                latest: PTY_OUTPUT_SEGMENT_BYTES + 17,
            }
        );
        assert!(matches!(
            store.read("job", 0, 16, false).expect("read"),
            AttachmentReadResult::CursorExpired { earliest_cursor, .. }
                if earliest_cursor == PTY_OUTPUT_SEGMENT_BYTES
        ));
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn reopens_and_reads_absolute_cursor_data() {
        let root =
            std::env::temp_dir().join(format!("koda-pty-reopen-{}", Uuid::new_v4().simple()));
        let mut store = PtyOutputStore::open(&root, 2 * PTY_OUTPUT_SEGMENT_BYTES).expect("store");
        store.append(b"hello").expect("append");
        drop(store);
        let reopened = PtyOutputStore::open(&root, 2 * PTY_OUTPUT_SEGMENT_BYTES).expect("reopen");
        let result = reopened.read("job", 0, 64, true).expect("read");

        match result {
            AttachmentReadResult::Ok {
                next_cursor,
                complete,
                data_base64,
                ..
            } => {
                assert_eq!(next_cursor, 5);
                assert!(complete);
                assert_eq!(
                    base64::engine::general_purpose::STANDARD
                        .decode(data_base64)
                        .expect("base64"),
                    b"hello"
                );
            }
            AttachmentReadResult::CursorExpired { .. } => panic!("cursor was retained"),
        }
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
