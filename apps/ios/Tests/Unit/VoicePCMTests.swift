import XCTest
@testable import NavigationAssistant

final class VoicePCMTests: XCTestCase {
    func testFrameSizeIsOneHundredMillisecondsAt24kHz() {
        XCTAssertEqual(PCM.frameBytes, 4800)
        XCTAssertEqual(PCM.seconds(bytes: 4800), 0.1, accuracy: 1e-9)
    }

    func testChunkerEmitsWholeFramesAndCarriesRemainders() {
        var chunker = PCMChunker(frameBytes: 8)
        XCTAssertEqual(chunker.append(Data(repeating: 1, count: 5)), [])
        XCTAssertEqual(chunker.pendingBytes, 5)
        let frames = chunker.append(Data(repeating: 2, count: 12))    // 17 bytes pending -> two frames + 1 byte
        XCTAssertEqual(frames.count, 2)
        XCTAssertEqual(frames[0], Data([1, 1, 1, 1, 1, 2, 2, 2]))
        XCTAssertEqual(frames[1], Data(repeating: 2, count: 8))
        XCTAssertEqual(chunker.pendingBytes, 1)
        XCTAssertNil(chunker.drain())                                   // a lone byte is not a sample
        XCTAssertEqual(chunker.append(Data([9, 9, 9])).count, 0)
        XCTAssertEqual(chunker.drain(), Data([9, 9]))
        XCTAssertEqual(chunker.pendingBytes, 0)
    }

    func testInt16RoundTripClampsAndKeepsOrder() {
        let data = PCM.int16Data([0, 0.5, -0.5, 2, -2])
        XCTAssertEqual(data.count, 10)
        let back = PCM.floats(data)
        XCTAssertEqual(back[0], 0, accuracy: 1e-4)
        XCTAssertEqual(back[1], 0.5, accuracy: 1e-4)
        XCTAssertEqual(back[2], -0.5, accuracy: 1e-4)
        XCTAssertEqual(back[3], 1, accuracy: 1e-4)
        XCTAssertEqual(back[4], -1, accuracy: 1e-4)
        // Little-endian on the wire: 0.5 * 32767 = 16383 = 0x3FFF.
        XCTAssertEqual(Array(data[2..<4]), [0xFF, 0x3F])
        XCTAssertEqual(PCM.floats(Data([0x00])), [])
    }

    func testLevelIsRootMeanSquare() {
        XCTAssertEqual(PCM.level(Data()), 0)
        XCTAssertEqual(PCM.level(PCM.int16Data([0, 0, 0, 0])), 0, accuracy: 1e-6)
        XCTAssertEqual(PCM.level(PCM.int16Data([0.5, -0.5, 0.5, -0.5])), 0.5, accuracy: 1e-3)
    }
}
