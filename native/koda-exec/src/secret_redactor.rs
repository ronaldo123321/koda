//! Exact-byte streaming redaction before native output persistence.

use crate::secret_policy::{
    EXECUTION_SECRET_MAX_SELECTION, EXECUTION_SECRET_VALUE_MAX_BYTES,
    EXECUTION_SECRET_VALUE_MIN_BYTES, EXECUTION_SECRET_VALUES_MAX_BYTES, SecretPolicyError,
};

pub const SECRET_REDACTION_MARKER: &[u8] = b"[REDACTED]";

#[derive(Debug)]
pub struct StreamingSecretRedactor {
    patterns: Vec<Vec<u8>>,
    maximum_pattern_bytes: usize,
    pending: Vec<u8>,
    finished: bool,
    replacements: u64,
}

impl StreamingSecretRedactor {
    pub fn new(mut values: Vec<Vec<u8>>) -> Result<Self, SecretPolicyError> {
        if values.len() > EXECUTION_SECRET_MAX_SELECTION {
            zero_values(&mut values);
            return Err(SecretPolicyError::SecretValueInvalid);
        }
        let mut total_bytes = 0usize;
        for index in 0..values.len() {
            let value_len = values[index].len();
            let Some(next_total) = total_bytes.checked_add(value_len) else {
                zero_values(&mut values);
                return Err(SecretPolicyError::SecretValueInvalid);
            };
            total_bytes = next_total;
            if !(EXECUTION_SECRET_VALUE_MIN_BYTES..=EXECUTION_SECRET_VALUE_MAX_BYTES)
                .contains(&value_len)
                || total_bytes > EXECUTION_SECRET_VALUES_MAX_BYTES
            {
                zero_values(&mut values);
                return Err(SecretPolicyError::SecretValueInvalid);
            }
        }
        values.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
        let mut patterns: Vec<Vec<u8>> = Vec::with_capacity(values.len());
        for mut value in values {
            if patterns.last().is_some_and(|previous| previous == &value) {
                value.fill(0);
            } else {
                patterns.push(value);
            }
        }
        let maximum_pattern_bytes = patterns.first().map_or(0, Vec::len);
        Ok(Self {
            patterns,
            maximum_pattern_bytes,
            pending: Vec::new(),
            finished: false,
            replacements: 0,
        })
    }

    pub fn replacement_count(&self) -> u64 {
        self.replacements
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<u8>, SecretPolicyError> {
        self.assert_open()?;
        if self.patterns.is_empty() {
            return Ok(chunk.to_vec());
        }
        let mut input = std::mem::take(&mut self.pending);
        input.extend_from_slice(chunk);
        let output = self.process(&input, false);
        input.fill(0);
        if output.is_err() {
            self.destroy();
        }
        output
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, SecretPolicyError> {
        self.assert_open()?;
        self.finished = true;
        if self.patterns.is_empty() {
            return Ok(Vec::new());
        }
        let mut final_bytes = std::mem::take(&mut self.pending);
        let output = self.process(&final_bytes, true);
        final_bytes.fill(0);
        zero_values(&mut self.patterns);
        output
    }

    pub fn destroy(&mut self) {
        self.finished = true;
        self.pending.fill(0);
        self.pending.clear();
        zero_values(&mut self.patterns);
    }

    fn process(&mut self, input: &[u8], final_chunk: bool) -> Result<Vec<u8>, SecretPolicyError> {
        let mut output = Vec::with_capacity(input.len());
        let mut cursor = 0usize;
        let mut literal_start = 0usize;
        while cursor < input.len()
            && (final_chunk || input.len() - cursor >= self.maximum_pattern_bytes)
        {
            let matched = self
                .patterns
                .iter()
                .find(|pattern| input[cursor..].starts_with(pattern));
            let Some(pattern) = matched else {
                cursor += 1;
                continue;
            };
            output.extend_from_slice(&input[literal_start..cursor]);
            output.extend_from_slice(SECRET_REDACTION_MARKER);
            cursor += pattern.len();
            literal_start = cursor;
            self.replacements = self
                .replacements
                .checked_add(1)
                .ok_or(SecretPolicyError::SecretRedactionFailed)?;
        }
        output.extend_from_slice(&input[literal_start..cursor]);
        if final_chunk {
            output.extend_from_slice(&input[cursor..]);
        } else {
            self.pending.extend_from_slice(&input[cursor..]);
        }
        Ok(output)
    }

    fn assert_open(&self) -> Result<(), SecretPolicyError> {
        if self.finished {
            Err(SecretPolicyError::SecretRedactionFailed)
        } else {
            Ok(())
        }
    }
}

impl Drop for StreamingSecretRedactor {
    fn drop(&mut self) {
        self.destroy();
    }
}

fn zero_values(values: &mut [Vec<u8>]) {
    for value in values {
        value.fill(0);
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use serde_json::Value;

    use super::*;

    fn fixtures() -> Value {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/testkit/fixtures/execution-secrets-v1.json"
        )))
        .unwrap()
    }

    fn decode(value: &Value) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(value.as_str().unwrap())
            .unwrap()
    }

    #[test]
    fn shared_streaming_redaction_cases_match() {
        for case in fixtures()["redaction_cases"].as_array().unwrap() {
            let values = case["secrets_base64"]
                .as_array()
                .unwrap()
                .iter()
                .map(decode)
                .collect();
            let mut redactor = StreamingSecretRedactor::new(values).unwrap();
            let mut output = Vec::new();
            for chunk in case["chunks_base64"].as_array().unwrap() {
                output.extend(redactor.push(&decode(chunk)).unwrap());
            }
            output.extend(redactor.finish().unwrap());
            assert_eq!(output, decode(&case["expected_base64"]), "{}", case["name"]);
            assert_eq!(
                redactor.replacement_count(),
                case["replacements"].as_u64().unwrap(),
                "{}",
                case["name"]
            );
            if let Some(limit) = case["output_limit_bytes"].as_u64() {
                assert_eq!(
                    &output[..limit as usize],
                    decode(&case["expected_limited_base64"]),
                    "{}",
                    case["name"]
                );
            }
        }
    }

    #[test]
    fn every_split_boundary_is_redacted() {
        let sentinel = b"boundary-secret-value".to_vec();
        let input = b"before boundary-secret-value after";
        for split in 0..=input.len() {
            let mut redactor = StreamingSecretRedactor::new(vec![sentinel.clone()]).unwrap();
            let mut output = redactor.push(&input[..split]).unwrap();
            output.extend(redactor.push(&input[split..]).unwrap());
            output.extend(redactor.finish().unwrap());
            assert_eq!(output, b"before [REDACTED] after");
            assert_eq!(redactor.replacement_count(), 1);
        }
    }

    #[test]
    fn invalid_values_and_reuse_fail_with_fixed_errors() {
        for values in [
            vec![b"short".to_vec()],
            vec![vec![b'x'; EXECUTION_SECRET_VALUE_MAX_BYTES + 1]],
            vec![vec![b'x'; EXECUTION_SECRET_VALUE_MAX_BYTES]; 9],
        ] {
            assert_eq!(
                StreamingSecretRedactor::new(values).unwrap_err(),
                SecretPolicyError::SecretValueInvalid
            );
        }
        let mut redactor = StreamingSecretRedactor::new(vec![b"valid-secret".to_vec()]).unwrap();
        redactor.finish().unwrap();
        assert_eq!(
            redactor.push(b"value").unwrap_err(),
            SecretPolicyError::SecretRedactionFailed
        );
    }
}
